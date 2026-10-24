import { createHash, randomUUID } from "node:crypto";
import { validarHorarioPix } from "./pixDisponibilidade.js";
import { possuiBloqueio } from "./agendaBloqueios.js";
import { encontrarConflitoAgendamentoPix } from "./pixDocumentoAgendamento.js";

const ID_UID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ErroIsencaoPix extends Error {
  constructor(status, mensagem, codigo) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > 4096) throw new ErroIsencaoPix(413, "Requisição muito grande");
    partes.push(parte);
  }
  try {
    const dados = JSON.parse(Buffer.concat(partes).toString("utf8"));
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new Error("Objeto inválido");
    return dados;
  } catch {
    throw new ErroIsencaoPix(400, "JSON inválido");
  }
}

async function bancoPadrao() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  return getFirestore();
}

async function timestampPadrao() {
  const { FieldValue } = await import("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

async function conferirAdmin(db, uid) {
  const usuario = await db.collection("usuarios").doc(uid).get();
  if (!usuario.exists) return false;
  const dados = usuario.data();
  return dados.role === "admin" && dados.ativo === true;
}

function converterPreco(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) && valor > 0 ? valor : 0;
  const texto = String(valor ?? "").trim().replace(/R\$/gi, "").replace(/\s/g, "");
  const normalizado = texto.includes(",")
    ? texto.replace(/\./g, "").replace(",", ".")
    : texto;
  const numero = Number(normalizado);
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function validarFuturo(data, horario) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map((item) => [item.type, item.value]));
  const agora = `${valores.year}-${valores.month}-${valores.day}T${valores.hour}:${valores.minute}`;
  if (`${data}T${horario}` <= agora) throw new ErroIsencaoPix(409, "Horário já passou", "HORARIO_PASSADO");
}

function idAgendamento(uid, chave) {
  return `isento_${createHash("sha256").update(`${uid}:${chave}`).digest("hex").slice(0, 48)}`;
}

function dadosCompativeis(dados, esperado) {
  return dados?.clienteId === esperado.clienteId &&
    dados?.origemPagamento === "isencao_sinal_pix" &&
    dados?.idServico === esperado.idServico &&
    dados?.data === esperado.data && dados?.horario === esperado.horario;
}

export async function consultarIsencaoPix({ pool, uid }) {
  const resultado = await pool.query(
    "SELECT ativa FROM public.cliente_pix_isencoes WHERE cliente_uid = $1",
    [uid],
  );
  return resultado.rows[0]?.ativa === true;
}

export async function listarIsencoesPix({ pool, db, uid }) {
  if (!(await conferirAdmin(db, uid))) throw new ErroIsencaoPix(403, "Acesso administrativo negado");
  const resultado = await pool.query(
    "SELECT cliente_uid FROM public.cliente_pix_isencoes WHERE ativa = TRUE ORDER BY cliente_uid",
  );
  return resultado.rows.map((linha) => linha.cliente_uid);
}

export async function alterarIsencaoPix({ pool, db, adminUid, clienteUid, ativa }) {
  if (!(await conferirAdmin(db, adminUid))) throw new ErroIsencaoPix(403, "Acesso administrativo negado");
  if (typeof clienteUid !== "string" || !ID_UID.test(clienteUid) || typeof ativa !== "boolean") {
    throw new ErroIsencaoPix(400, "Cliente ou permissão inválida");
  }
  if (clienteUid === adminUid) throw new ErroIsencaoPix(400, "A permissão deve ser configurada para uma cliente");

  const perfil = await db.collection("clientes").doc(clienteUid).get();
  if (!perfil.exists || String(perfil.data()?.role || "").toLowerCase() === "admin") {
    throw new ErroIsencaoPix(404, "Cadastro de cliente não encontrado");
  }

  if (ativa) {
    await pool.query(`
      INSERT INTO public.cliente_pix_isencoes (cliente_uid, ativa, alterada_por_uid, revogada_em)
      VALUES ($1, TRUE, $2, NULL)
      ON CONFLICT (cliente_uid) DO UPDATE SET
        ativa = TRUE, alterada_por_uid = EXCLUDED.alterada_por_uid,
        atualizada_em = NOW(), revogada_em = NULL
    `, [clienteUid, adminUid]);
  } else {
    await pool.query(`
      INSERT INTO public.cliente_pix_isencoes (cliente_uid, ativa, alterada_por_uid, revogada_em)
      VALUES ($1, FALSE, $2, NOW())
      ON CONFLICT (cliente_uid) DO UPDATE SET
        ativa = FALSE, alterada_por_uid = EXCLUDED.alterada_por_uid,
        atualizada_em = NOW(), revogada_em = NOW()
    `, [clienteUid, adminUid]);
  }
  return { clienteUid, ativa };
}

export async function criarAgendamentoIsento({ pool, db, uid, dados, dependencies = {} }) {
  const servicoId = dados?.servicoId;
  const data = dados?.data;
  const horario = dados?.horario;
  const chave = dados?.chaveIdempotencia;
  if (typeof servicoId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(servicoId) ||
      typeof data !== "string" || typeof horario !== "string" ||
      typeof chave !== "string" || !UUID.test(chave)) {
    throw new ErroIsencaoPix(400, "Dados do agendamento inválidos");
  }

  const firestore = db || await bancoPadrao();
  const agendamentoId = idAgendamento(uid, chave);
  const esperado = { clienteId: uid, idServico: servicoId, data, horario };
  const referencia = firestore.collection("agendamentos").doc(agendamentoId);
  const repeticao = await referencia.get();
  if (repeticao.exists) {
    const registro = repeticao.data();
    if (!dadosCompativeis(registro, esperado) || registro.chaveIdempotencia !== chave) {
      throw new ErroIsencaoPix(409, "Chave de idempotência já utilizada", "IDEMPOTENCIA_DIVERGENTE");
    }
    if (!["agendado", "reagendado", "confirmado", "concluido"].includes(registro.status)) {
      throw new ErroIsencaoPix(409, "Este agendamento idempotente já foi cancelado", "AGENDAMENTO_CANCELADO");
    }
    return { agendamentoId, duracaoMinutos: Number(registro.duracao), agendamentoConfirmado: true, idempotente: true };
  }
  if (!(await consultarIsencaoPix({ pool, uid }))) {
    throw new ErroIsencaoPix(409, "Esta conta não está autorizada a agendar sem sinal PIX", "ISENCAO_INATIVA");
  }

  const servicoSnap = await firestore.collection("servicos").doc(servicoId).get();
  if (!servicoSnap.exists || servicoSnap.data()?.ativo === false) {
    throw new ErroIsencaoPix(404, "Serviço indisponível");
  }
  const servico = servicoSnap.data();
  const duracao = Number(servico.duracao ?? servico.duracaoMinutos ?? servico.tempo);
  const periodo = (dependencies.validarHorario || validarHorarioPix)(data, horario, duracao);
  if (!periodo.valido) throw new ErroIsencaoPix(400, periodo.motivo, "HORARIO_INVALIDO");
  validarFuturo(data, horario);

  const clienteSnap = await firestore.collection("clientes").doc(uid).get();
  const nomeCliente = String(
    clienteSnap.data()?.nome || clienteSnap.data()?.nomeCliente || "Cliente",
  ).trim().slice(0, 120) || "Cliente";
  const observacoes = typeof dados.observacoes === "string" ? dados.observacoes.trim().slice(0, 1000) : "";
  const preco = converterPreco(servico.preco ?? servico.valor ?? servico.valorReferencia);
  const timestamp = dependencies.serverTimestamp || await timestampPadrao();
  const conexao = await pool.connect();
  let documentoCriado = false;
  let confirmouSql = false;

  try {
    await conexao.query("BEGIN");
    await conexao.query(
      "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
      [data],
    );

    const permissao = await conexao.query(
      "SELECT ativa FROM public.cliente_pix_isencoes WHERE cliente_uid = $1 FOR SHARE",
      [uid],
    );
    if (permissao.rows[0]?.ativa !== true) {
      throw new ErroIsencaoPix(409, "A autorização para agendar sem sinal foi revogada", "ISENCAO_INATIVA");
    }

    if (await possuiBloqueio(conexao, data, periodo.inicioMinuto, periodo.fimMinuto)) {
      throw new ErroIsencaoPix(409, "Agenda fechada pela profissional neste horário", "AGENDA_FECHADA");
    }

    const reservaPropria = await conexao.query(`
      SELECT id, cliente_uid, cobranca_id
      FROM public.pix_reservas
      WHERE agendamento_id = $1
      FOR UPDATE
    `, [agendamentoId]);
    if (reservaPropria.rows[0] &&
        (reservaPropria.rows[0].cliente_uid !== uid || reservaPropria.rows[0].cobranca_id)) {
      throw new ErroIsencaoPix(409, "Reserva existente incompatível com isenção", "RESERVA_DIVERGENTE");
    }

    const reservas = reservaPropria.rowCount ? { rowCount: 0 } : await conexao.query(`
      SELECT inicio_minuto, fim_minuto
      FROM public.pix_reservas
      WHERE data_servico = $1
        AND estado IN ('reservada', 'confirmada')
        AND int4range(inicio_minuto, fim_minuto, '[)') && int4range($2, $3, '[)')
      LIMIT 1
    `, [data, periodo.inicioMinuto, periodo.fimMinuto]);
    if (reservas.rowCount > 0) {
      throw new ErroIsencaoPix(409, "Horário temporariamente reservado para pagamento PIX", "HORARIO_RESERVADO_PIX");
    }
    if (!reservaPropria.rowCount) {
      await conexao.query(`
        INSERT INTO public.pix_reservas (
          id, cliente_uid, servico_id, data_servico,
          inicio_minuto, fim_minuto, estado, vence_em, cobranca_id, agendamento_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'confirmada', NOW(), NULL, $7)
      `, [randomUUID(), uid, servicoId, data, periodo.inicioMinuto, periodo.fimMinuto, agendamentoId]);
    }

    await firestore.runTransaction(async (transacao) => {
      const existente = await transacao.get(referencia);
      if (existente.exists) {
        const registro = existente.data();
        if (!dadosCompativeis(registro, esperado)) {
          throw new ErroIsencaoPix(409, "Chave de idempotência já utilizada", "IDEMPOTENCIA_DIVERGENTE");
        }
        if (!["agendado", "reagendado", "confirmado", "concluido"].includes(registro.status)) {
          throw new ErroIsencaoPix(409, "Este agendamento idempotente já foi cancelado", "AGENDAMENTO_CANCELADO");
        }
        documentoCriado = false;
        return;
      }

      const doDia = await transacao.get(
        firestore.collection("agendamentos").where("data", "==", data),
      );
      const conflito = encontrarConflitoAgendamentoPix(
        doDia.docs.map((documento) => documento.data()),
        periodo.inicioMinuto,
        periodo.fimMinuto,
      );
      if (conflito) throw new ErroIsencaoPix(409, "Horário ocupado por outro agendamento", "HORARIO_OCUPADO");

      const agendamento = {
        ...esperado,
        nomeCliente,
        servico: String(servico.nome || "Serviço").slice(0, 120),
        duracao,
        precoSnapshot: preco,
        duracaoSnapshot: duracao,
        observacoes,
        status: "confirmado",
        origemPagamento: "isencao_sinal_pix",
        sinalPixIsento: true,
        calendarEventId: `evt_${agendamentoId}`,
        chaveIdempotencia: chave,
        criadoPorBackend: true,
        dataCriacao: timestamp,
        confirmadoEm: timestamp,
      };
      transacao.create(referencia, agendamento);
      documentoCriado = true;
    });

    // Somente um agendamento confirmado entra na fila duravel do Calendar.
    // A mesma fila e processada pelo worker para PIX pago e sinal isento.
    await conexao.query(`
      INSERT INTO public.pix_calendar_outbox (
        event_id, agendamento_id, nome_cliente, servico,
        data_servico, horario, duracao_minutos
      ) VALUES ($1, $2, $3, $4, $5::date, $6::time, $7)
      ON CONFLICT (event_id) DO NOTHING
    `, [
      `evt_${agendamentoId}`, agendamentoId, nomeCliente,
      String(servico.nome || "Serviço").slice(0, 120),
      data, horario, duracao
    ]);

    await conexao.query("COMMIT");
    confirmouSql = true;
    return { agendamentoId, duracaoMinutos: duracao, agendamentoConfirmado: true, idempotente: !documentoCriado };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    if (documentoCriado && !confirmouSql) {
      try {
        await firestore.runTransaction(async (transacao) => {
          const atual = await transacao.get(referencia);
          if (atual.exists && atual.data()?.chaveIdempotencia === chave &&
              atual.data()?.clienteId === uid && atual.data()?.origemPagamento === "isencao_sinal_pix") {
            transacao.delete(referencia);
          }
        });
      } catch (compensacao) {
        console.error("[Isenção PIX] Falha na compensação Firestore; documento mantido para bloquear o horário:", compensacao.message);
      }
    }
    throw erro;
  } finally {
    conexao.release();
  }
}

export async function reagendarComBloqueio({ pool, db, uid, dados, dependencies = {} }) {
  const firestore = db || await bancoPadrao();
  const agendamentoId = dados?.agendamentoId;
  const servicoId = dados?.servicoId;
  const data = dados?.data;
  const horario = dados?.horario;
  if (typeof agendamentoId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(agendamentoId) ||
      typeof servicoId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(servicoId) ||
      typeof data !== "string" || typeof horario !== "string") {
    throw new ErroIsencaoPix(400, "Dados do reagendamento inválidos");
  }

  const servicoSnap = await firestore.collection("servicos").doc(servicoId).get();
  if (!servicoSnap.exists || servicoSnap.data()?.ativo === false) {
    throw new ErroIsencaoPix(404, "Serviço indisponível");
  }
  const servico = servicoSnap.data();
  const duracao = Number(servico.duracao ?? servico.duracaoMinutos ?? servico.tempo);
  const periodo = (dependencies.validarHorario || validarHorarioPix)(data, horario, duracao);
  if (!periodo.valido) throw new ErroIsencaoPix(400, periodo.motivo, "HORARIO_INVALIDO");
  validarFuturo(data, horario);

  const referencia = firestore.collection("agendamentos").doc(agendamentoId);
  const inicial = await referencia.get();
  if (!inicial.exists) throw new ErroIsencaoPix(404, "Agendamento não encontrado");
  const dadosAtuais = inicial.data();
  const admin = await conferirAdmin(firestore, uid);
  if (!admin && dadosAtuais.clienteId !== uid) throw new ErroIsencaoPix(403, "Este agendamento não pertence à sua conta");
  if (dadosAtuais.pixCobrancaId || dadosAtuais.pixPagamentoId) {
    throw new ErroIsencaoPix(409, "Agendamento com PIX exige conciliação financeira pelo salão", "PIX_REQUER_CONCILIACAO");
  }
  if (!["agendado", "reagendado", "confirmado"].includes(dadosAtuais.status)) {
    throw new ErroIsencaoPix(409, "Este agendamento não pode ser reagendado", "AGENDAMENTO_INATIVO");
  }

  const dataAnterior = String(dadosAtuais.data || dadosAtuais.dataAgendamento || "");
  const datasBloqueadas = [...new Set([dataAnterior, data])].sort();
  const conexao = await pool.connect();
  let documentoAlterado = false;
  let documentoAnterior = null;
  const eventId = String(dadosAtuais.calendarEventId || `evt_${agendamentoId}`);
  const operacaoId = randomUUID();
  const timestamp = dependencies.serverTimestamp || await timestampPadrao();

  try {
    await conexao.query("BEGIN");
    for (const dataBloqueada of datasBloqueadas) {
      await conexao.query(
        "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
        [dataBloqueada],
      );
    }

    if (await possuiBloqueio(conexao, data, periodo.inicioMinuto, periodo.fimMinuto)) {
      throw new ErroIsencaoPix(409, "Agenda fechada pela profissional neste horário", "AGENDA_FECHADA");
    }

    const reservaExistente = await conexao.query(`
      SELECT id, cliente_uid, cobranca_id
      FROM public.pix_reservas
      WHERE agendamento_id = $1
      FOR UPDATE
    `, [agendamentoId]);
    if (reservaExistente.rows[0] &&
        (reservaExistente.rows[0].cliente_uid !== dadosAtuais.clienteId || reservaExistente.rows[0].cobranca_id)) {
      throw new ErroIsencaoPix(409, "Reserva existente incompatível com reagendamento", "RESERVA_DIVERGENTE");
    }

    const reservas = await conexao.query(`
      SELECT inicio_minuto, fim_minuto
      FROM public.pix_reservas
      WHERE data_servico = $1
        AND estado IN ('reservada', 'confirmada')
        AND int4range(inicio_minuto, fim_minuto, '[)') && int4range($2, $3, '[)')
        AND agendamento_id IS DISTINCT FROM $4
      LIMIT 1
    `, [data, periodo.inicioMinuto, periodo.fimMinuto, agendamentoId]);
    if (reservas.rowCount > 0) {
      throw new ErroIsencaoPix(409, "Horário temporariamente reservado para pagamento PIX", "HORARIO_RESERVADO_PIX");
    }

    if (reservaExistente.rowCount) {
      await conexao.query(`
        UPDATE public.pix_reservas
        SET servico_id = $2, data_servico = $3, inicio_minuto = $4, fim_minuto = $5,
            vence_em = NOW(), estado = 'confirmada', atualizado_em = NOW()
        WHERE id = $1 AND cobranca_id IS NULL
      `, [reservaExistente.rows[0].id, servicoId, data, periodo.inicioMinuto, periodo.fimMinuto]);
    } else {
      await conexao.query(`
        INSERT INTO public.pix_reservas (
          id, cliente_uid, servico_id, data_servico,
          inicio_minuto, fim_minuto, estado, vence_em, cobranca_id, agendamento_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'confirmada', NOW(), NULL, $7)
      `, [randomUUID(), dadosAtuais.clienteId, servicoId, data, periodo.inicioMinuto, periodo.fimMinuto, agendamentoId]);
    }

    await firestore.runTransaction(async (transacao) => {
      const atualSnap = await transacao.get(referencia);
      if (!atualSnap.exists) throw new ErroIsencaoPix(404, "Agendamento não encontrado");
      const atual = atualSnap.data();
      if (!admin && atual.clienteId !== uid) throw new ErroIsencaoPix(403, "Este agendamento não pertence à sua conta");
      if (atual.pixCobrancaId || atual.pixPagamentoId) {
        throw new ErroIsencaoPix(409, "Agendamento com PIX exige conciliação financeira pelo salão", "PIX_REQUER_CONCILIACAO");
      }
      if (!["agendado", "reagendado", "confirmado"].includes(atual.status)) {
        throw new ErroIsencaoPix(409, "Este agendamento não pode ser reagendado", "AGENDAMENTO_INATIVO");
      }
      if (atual.data === data && atual.horario === horario && atual.idServico === servicoId) {
        documentoAnterior = atual;
        documentoAlterado = false;
        return;
      }

      const doDia = await transacao.get(
        firestore.collection("agendamentos").where("data", "==", data),
      );
      const registros = doDia.docs
        .filter((documento) => documento.id !== agendamentoId)
        .map((documento) => documento.data());
      if (encontrarConflitoAgendamentoPix(registros, periodo.inicioMinuto, periodo.fimMinuto)) {
        throw new ErroIsencaoPix(409, "Horário ocupado por outro agendamento", "HORARIO_OCUPADO");
      }

      documentoAnterior = atual;
      transacao.update(referencia, {
        servico: String(servico.nome || "Serviço").slice(0, 120),
        idServico: servicoId,
        data,
        horario,
        duracao,
        duracaoSnapshot: duracao,
        precoSnapshot: converterPreco(servico.preco ?? servico.valor ?? servico.valorReferencia),
        observacoes: typeof dados.observacoes === "string" ? dados.observacoes.trim().slice(0, 1000) : "",
        calendarEventId: eventId,
        status: "reagendado",
        reagendadoEm: timestamp,
        reagendadoPor: uid,
        reagendamentoOperacao: operacaoId,
      });
      documentoAlterado = true;
    });

    await conexao.query("COMMIT");
    return { agendamentoId, calendarEventId: eventId, duracaoMinutos: duracao, reagendado: documentoAlterado };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    if (documentoAlterado && documentoAnterior) {
      try {
        await firestore.runTransaction(async (transacao) => {
          const atual = await transacao.get(referencia);
          if (atual.exists && atual.data()?.reagendamentoOperacao === operacaoId &&
              atual.data()?.data === data && atual.data()?.horario === horario) {
            transacao.set(referencia, documentoAnterior);
          }
        });
      } catch (compensacao) {
        console.error("[Reagendamento] Falha na compensação Firestore; verifique a agenda:", compensacao.message);
      }
    }
    throw erro;
  } finally {
    conexao.release();
  }
}

export async function atenderAgendamentoIsencao(req, res, pool, dependencies = {}) {
  let uid;
  try {
    const verificar = dependencies.verificarUsuario || (await import("./pushSubscriptions.js")).verificarUsuario;
    uid = await verificar(req);
  }
  catch { responder(res, 401, { erro: "Não autenticado" }); return; }

  const db = dependencies.firestore || await bancoPadrao();
  const caminho = new URL(req.url, "http://localhost").pathname;
  try {
    if (req.method === "GET" && caminho === "/agendamentos/isencao") {
      responder(res, 200, { isentaSinalPix: await consultarIsencaoPix({ pool, uid }) });
      return;
    }
    if (req.method === "GET" && caminho === "/admin/isencoes-sinal-pix") {
      const clientes = await listarIsencoesPix({ pool, db, uid });
      responder(res, 200, { clientes });
      return;
    }
    if (req.method === "PATCH" && caminho === "/admin/clientes/isencao-sinal-pix") {
      const dados = await lerJson(req);
      const resultado = await alterarIsencaoPix({
        pool, db, adminUid: uid, clienteUid: dados.clienteUid, ativa: dados.ativa,
      });
      responder(res, 200, resultado);
      return;
    }
    if (req.method === "POST" && caminho === "/agendamentos/sem-pix") {
      const dados = await lerJson(req);
      const resultado = await criarAgendamentoIsento({ pool, db, uid, dados, dependencies });
      responder(res, 201, resultado);
      return;
    }
    if (req.method === "POST" && caminho === "/agendamentos/reagendar") {
      const dados = await lerJson(req);
      const resultado = await reagendarComBloqueio({ pool, db, uid, dados, dependencies });
      responder(res, 200, resultado);
      return;
    }
    responder(res, 404, { erro: "Rota não encontrada" });
  } catch (erro) {
    if (erro?.code === "23P01") {
      responder(res, 409, { erro: "Horário reservado por outra cliente", codigo: "HORARIO_OCUPADO" });
      return;
    }
    if (erro instanceof ErroIsencaoPix) {
      responder(res, erro.status, { erro: erro.message, ...(erro.codigo ? { codigo: erro.codigo } : {}) });
      return;
    }
    console.error("[Isenção PIX] Falha na operação:", erro.message);
    responder(res, 500, { erro: "Falha ao processar a isenção de sinal" });
  }
}
