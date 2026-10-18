const ACOES_CANCELAMENTO = new Map([
  ["cancelar_cliente", { tipo: "cliente", status: "cancelado_cliente" }],
  ["cancelar_admin", { tipo: "profissional", status: "cancelado_profissional" }]
]);
const STATUS_ATIVOS = new Set(["agendado", "reagendado", "confirmado"]);

export class ErroCancelamento extends Error {
  constructor(status, mensagem, permanente = false) {
    super(mensagem);
    this.status = status;
    this.permanente = permanente;
  }
}

function texto(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

function validarAtor(acao, uid, usuario) {
  if (acao.tipo === "profissional" &&
      (!usuario?.exists || usuario.data()?.role !== "admin" || usuario.data()?.ativo !== true)) {
    throw new ErroCancelamento(403, "Acesso administrativo negado", true);
  }
}

async function obterFieldValue() {
  const { FieldValue } = await import("firebase-admin/firestore");
  return FieldValue;
}

async function inicializarFirestore() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  }
  return getFirestore();
}

async function validarSolicitacaoFirestore(db, { uid, agendamentoId, acao }) {
  return db.runTransaction(async (transacao) => {
    let perfil;
    if (acao.tipo === "profissional") {
      perfil = await transacao.get(db.collection("usuarios").doc(uid));
      validarAtor(acao, uid, perfil);
    }

    const referencia = db.collection("agendamentos").doc(agendamentoId);
    const documento = await transacao.get(referencia);
    if (!documento.exists) throw new ErroCancelamento(404, "Agendamento não encontrado", true);

    const dados = documento.data();
    if (acao.tipo === "cliente" && texto(dados.clienteId) !== uid) {
      throw new ErroCancelamento(403, "Agendamento não pertence ao usuário", true);
    }
    if (!STATUS_ATIVOS.has(texto(dados.status)) &&
        !(dados.status === acao.status && dados.canceladoPor === uid)) {
      throw new ErroCancelamento(409, "Cancelamento não permitido", true);
    }

    const cobrancaId = texto(dados.pixCobrancaId);
    if (cobrancaId && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cobrancaId)) {
      throw new ErroCancelamento(409, "Vínculo da cobrança PIX inválido", true);
    }

    return {
      clienteUid: texto(dados.clienteId),
      cobrancaId: cobrancaId || null,
      calendarEventId: texto(dados.calendarEventId) ||
        (cobrancaId ? `evt_${agendamentoId}` : null)
    };
  });
}

async function registrarSolicitacao(pool, dados) {
  await pool.query(`
    INSERT INTO public.agendamento_cancelamentos (
      agendamento_id, cobranca_id, cliente_uid, solicitante_uid,
      tipo, calendar_event_id, calendar_estado
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (agendamento_id) DO NOTHING
  `, [
    dados.agendamentoId,
    dados.cobrancaId,
    dados.clienteUid,
    dados.uid,
    dados.acao.tipo,
    dados.calendarEventId,
    dados.calendarEventId ? "pendente" : "dispensado"
  ]);

  const resultado = await pool.query(`
    SELECT * FROM public.agendamento_cancelamentos
    WHERE agendamento_id = $1
  `, [dados.agendamentoId]);
  const solicitacao = resultado.rows[0];
  if (!solicitacao || solicitacao.solicitante_uid !== dados.uid ||
      solicitacao.tipo !== dados.acao.tipo || solicitacao.cliente_uid !== dados.clienteUid) {
    throw new ErroCancelamento(409, "Já existe uma solicitação de cancelamento incompatível", true);
  }
  if (solicitacao.estado === "falha_permanente") {
    throw new ErroCancelamento(409, "Cancelamento requer revisão administrativa", true);
  }
  return solicitacao;
}

async function aplicarCancelamentoFirestore(db, solicitacao, dependencies = {}) {
  const obterReferencia = dependencies.obterReferencia || (() =>
    db.collection("agendamentos").doc(solicitacao.agendamento_id));
  const reference = obterReferencia();
  const fieldValue = dependencies.FieldValue || await obterFieldValue();
  const statusAlvo = solicitacao.tipo === "cliente"
    ? "cancelado_cliente"
    : "cancelado_profissional";

  return db.runTransaction(async (transacao) => {
    const perfilRef = db.collection("usuarios").doc(solicitacao.solicitante_uid);
    let perfil;
    if (solicitacao.tipo === "profissional") {
      perfil = await transacao.get(perfilRef);
      validarAtor({ tipo: "profissional" }, solicitacao.solicitante_uid, perfil);
    }

    const snapshot = await transacao.get(reference);
    if (!snapshot.exists) throw new ErroCancelamento(404, "Agendamento não encontrado", true);
    const dados = snapshot.data();

    if (solicitacao.tipo === "cliente" && dados.clienteId !== solicitacao.solicitante_uid) {
      throw new ErroCancelamento(403, "Agendamento não pertence ao usuário", true);
    }
    if (dados.status === statusAlvo && dados.canceladoPor === solicitacao.solicitante_uid) {
      return { status: statusAlvo, jaCancelado: true };
    }
    if (!STATUS_ATIVOS.has(texto(dados.status))) {
      throw new ErroCancelamento(409, "O agendamento mudou de estado antes do cancelamento", true);
    }

    transacao.update(reference, {
      status: statusAlvo,
      canceladoEm: fieldValue.serverTimestamp(),
      canceladoPor: solicitacao.solicitante_uid,
      canceladoPorTipo: solicitacao.tipo,
      atualizadoEm: fieldValue.serverTimestamp(),
      atualizadoPor: solicitacao.solicitante_uid
    });
    return { status: statusAlvo, jaCancelado: false };
  });
}

export async function processarCancelamentoAgendamento(pool, agendamentoId, dependencies = {}) {
  const db = dependencies.firestore || await inicializarFirestore();
  const atualizarFirestore = dependencies.atualizarFirestore ||
    ((solicitacao) => aplicarCancelamentoFirestore(db, solicitacao, dependencies));
  const conexao = await pool.connect();
  let firestoreCancelado = false;

  try {
    await conexao.query("BEGIN");
    const solicitacoes = await conexao.query(`
      SELECT * FROM public.agendamento_cancelamentos
      WHERE agendamento_id = $1
      FOR UPDATE
    `, [agendamentoId]);
    const solicitacao = solicitacoes.rows[0];
    if (!solicitacao) throw new ErroCancelamento(404, "Solicitação não encontrada", true);
    if (solicitacao.estado === "concluida") {
      await conexao.query("COMMIT");
      return { concluido: true, idempotente: true, pixPago: false };
    }
    if (solicitacao.estado === "falha_permanente") {
      throw new ErroCancelamento(409, "Cancelamento requer revisão administrativa", true);
    }

    let pagamentoPaga = false;
    if (solicitacao.cobranca_id) {
      const vinculo = await conexao.query(`
        SELECT c.id, c.estado AS cobranca_estado,
               r.id AS reserva_id, r.estado AS reserva_estado,
               r.agendamento_id AS reserva_agendamento_id,
               c.agendamento_id AS cobranca_agendamento_id
        FROM public.pix_cobrancas c
        JOIN public.pix_reservas r ON r.cobranca_id = c.id
        WHERE c.id = $1
          AND (r.agendamento_id = $2 OR c.agendamento_id = $2)
        FOR UPDATE OF c, r
      `, [solicitacao.cobranca_id, agendamentoId]);
      const registro = vinculo.rows[0];
      if (!registro) {
        throw new ErroCancelamento(409, "Vínculo entre cobrança, reserva e agendamento divergente", true);
      }
      pagamentoPaga = registro.cobranca_estado === "paga";
      if (registro.reserva_estado !== "cancelada") {
        const liberacao = await conexao.query(`
          UPDATE public.pix_reservas
          SET estado = 'cancelada', atualizado_em = NOW()
          WHERE id = $1 AND cobranca_id = $2
            AND (agendamento_id = $3 OR agendamento_id IS NULL)
            AND estado IN ('reservada', 'confirmada', 'expirada')
          RETURNING id
        `, [registro.reserva_id, solicitacao.cobranca_id, agendamentoId]);
        if (!liberacao.rowCount) {
          throw new Error("A reserva PIX não pôde ser liberada com segurança");
        }
      }
    } else {
      // Agendamentos isentos e antigos sem PIX também possuem uma reserva
      // confirmada quando passaram pela API. A liberação fica na mesma
      // transação SQL do cancelamento e só ocorre junto da mudança no Firestore.
      await conexao.query(`
        UPDATE public.pix_reservas
        SET estado = 'cancelada', atualizado_em = NOW()
        WHERE agendamento_id = $1
          AND cliente_uid = $2
          AND cobranca_id IS NULL
          AND estado = 'confirmada'
      `, [agendamentoId, solicitacao.cliente_uid]);
    }

    try {
      await atualizarFirestore(solicitacao);
      firestoreCancelado = true;
    } catch (erro) {
      if (erro instanceof ErroCancelamento) throw erro;
      erro.firestoreCancelado = false;
      throw erro;
    }

    await conexao.query(`
      UPDATE public.agendamento_cancelamentos
      SET estado = 'concluida', concluido_em = COALESCE(concluido_em, NOW()),
          bloqueado_ate = NULL, ultimo_erro = NULL, atualizado_em = NOW()
      WHERE agendamento_id = $1
    `, [agendamentoId]);
    await conexao.query("COMMIT");
    return { concluido: true, idempotente: false, pixPago: pagamentoPaga };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    erro.firestoreCancelado = firestoreCancelado;
    throw erro;
  } finally {
    conexao.release();
  }
}

export async function solicitarCancelamentoAgendamento({
  pool,
  firestore,
  uid,
  agendamentoId,
  acao,
  dependencies = {}
}) {
  const regra = ACOES_CANCELAMENTO.get(acao);
  if (!regra) throw new ErroCancelamento(400, "Ação de cancelamento inválida", true);

  const db = firestore || dependencies.firestore || await inicializarFirestore();
  const vinculo = await validarSolicitacaoFirestore(db, {
    uid,
    agendamentoId,
    acao: regra
  });
  let calendarEventId = vinculo.calendarEventId;
  if (!calendarEventId && vinculo.cobrancaId) {
    calendarEventId = `evt_${agendamentoId}`;
  }

  await registrarSolicitacao(pool, {
    agendamentoId,
    uid,
    acao: regra,
    clienteUid: vinculo.clienteUid,
    cobrancaId: vinculo.cobrancaId,
    calendarEventId
  });

  try {
    const resultado = await processarCancelamentoAgendamento(pool, agendamentoId, {
      ...dependencies,
      firestore: db
    });
    return { ...resultado, firestoreCancelado: true, cancelamentoPendente: false };
  } catch (erro) {
    if (erro instanceof ErroCancelamento && erro.permanente) {
      await pool.query(`
        UPDATE public.agendamento_cancelamentos
        SET estado = 'falha_permanente', ultimo_erro = $2,
            bloqueado_ate = NULL, atualizado_em = NOW()
        WHERE agendamento_id = $1 AND estado = 'solicitada'
      `, [agendamentoId, erro.message.slice(0, 300)]).catch(() => {});
      throw erro;
    }
    await pool.query(`
      UPDATE public.agendamento_cancelamentos
      SET tentativas = tentativas + 1,
          proxima_tentativa_em = NOW() + INTERVAL '15 seconds',
          ultimo_erro = $2,
          atualizado_em = NOW()
      WHERE agendamento_id = $1 AND estado = 'solicitada'
    `, [agendamentoId, String(erro?.message || "Falha temporária").slice(0, 300)]).catch(() => {});
    return {
      concluido: false,
      cancelamentoPendente: true,
      firestoreCancelado: erro.firestoreCancelado === true,
      pixPago: false
    };
  }
}

export async function processarProximoCancelamentoAgendamento(pool, dependencies = {}) {
  const claimed = await pool.query(`
    WITH proxima AS (
      SELECT agendamento_id
      FROM public.agendamento_cancelamentos
      WHERE estado = 'solicitada'
        AND proxima_tentativa_em <= NOW()
        AND (bloqueado_ate IS NULL OR bloqueado_ate <= NOW())
      ORDER BY criado_em
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE public.agendamento_cancelamentos AS fila
    SET tentativas = tentativas + 1,
        bloqueado_ate = NOW() + INTERVAL '2 minutes',
        atualizado_em = NOW()
    FROM proxima
    WHERE fila.agendamento_id = proxima.agendamento_id
    RETURNING fila.agendamento_id
  `);
  const agendamentoId = claimed.rows[0]?.agendamento_id;
  if (!agendamentoId) return { processado: false };

  try {
    const resultado = await processarCancelamentoAgendamento(pool, agendamentoId, dependencies);
    return { processado: true, ...resultado };
  } catch (erro) {
    const atraso = Math.min(3600, 15 * (2 ** Math.min(Number(claimed.rows[0].tentativas || 1), 7)));
    await pool.query(`
      UPDATE public.agendamento_cancelamentos
      SET estado = CASE WHEN $2::boolean THEN 'falha_permanente' ELSE 'solicitada' END,
          bloqueado_ate = NULL,
          proxima_tentativa_em = NOW() + ($3::integer * INTERVAL '1 second'),
          ultimo_erro = $4,
          atualizado_em = NOW()
      WHERE agendamento_id = $1 AND estado = 'solicitada'
    `, [agendamentoId, erro.permanente === true, atraso,
      String(erro?.message || "Falha temporária").slice(0, 300)]);
    if (erro.permanente) {
      console.error("[Cancelamento] Solicitação exige revisão manual.");
    }
    return { processado: true, concluido: false, permanente: erro.permanente === true };
  }
}

export function iniciarWorkerAgendamentoCancelamentos(pool) {
  let ocupado = false;
  const executar = async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      await processarProximoCancelamentoAgendamento(pool);
    } catch {
      console.error("[Cancelamento] Worker temporariamente indisponível.");
    } finally {
      ocupado = false;
    }
  };
  const timer = setInterval(executar, 5000);
  timer.unref?.();
  executar();
  return () => clearInterval(timer);
}
