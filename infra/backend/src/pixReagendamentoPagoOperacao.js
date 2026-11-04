import { randomUUID } from "node:crypto";
import { possuiBloqueio } from "./agendaBloqueios.js";
import { encontrarConflitoAgendamentoPix } from "./pixDocumentoAgendamento.js";
import {
  montarPayloadReagendamentoPix,
  enviarReagendamentoPix,
  validarPagamentoPixReagendamento,
} from "./pixReagendamentoPago.js";
import { URL_APPS_SCRIPT } from "./pixCalendarWorker.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATIVOS = new Set(["agendado", "confirmado", "reagendado"]);

export class ErroReagendamentoPago extends Error {
  constructor(status, mensagem, codigo = "REAGENDAMENTO_PIX_INVALIDO") {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

async function firestorePadrao() {
  const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  return getFirestore();
}

async function fieldValuePadrao() {
  return (await import("firebase-admin/firestore")).FieldValue;
}

function minutos(horario) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
    throw new ErroReagendamentoPago(400, "Horário inválido");
  }
  return Number(horario.slice(0, 2)) * 60 + Number(horario.slice(3, 5));
}

function hora(minutosNumero) {
  return String(Math.floor(minutosNumero / 60)).padStart(2, "0") + ":" +
    String(minutosNumero % 60).padStart(2, "0");
}

async function bloquearDatas(conexao, datas) {
  for (const data of [...new Set(datas)].sort()) {
    await conexao.query(
      "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
      [data],
    );
  }
}

function destinoIgual(op, agendamentoId, uid, servicoId, data, inicio) {
  return op.agendamento_id === agendamentoId &&
    (op.solicitante_uid === uid || op.cliente_uid === uid) &&
    op.servico_id === servicoId &&
    op.destino_data_iso === data &&
    Number(op.destino_inicio) === inicio;
}

async function buscarOperacao(pool, id, uid) {
  const result = await pool.query(
    \`SELECT operation_id, agendamento_id, solicitante_uid, cliente_uid,
        estado, ultimo_erro, criado_em, concluido_em,
        TO_CHAR(destino_data, 'YYYY-MM-DD') AS destino_data_iso
      FROM public.pix_reagendamentos_pagos
      WHERE operation_id = $1 AND (solicitante_uid = $2 OR cliente_uid = $2)\`,
    [id, uid],
  );
  return result.rows[0] || null;
}

/**
 * Inicia uma operação durável sem modificar nem a cobrança nem o evento.
 * Mantém o horário original e protege o novo no PostgreSQL. Se os horários
 * se sobrepõem no mesmo dia, amplia temporariamente a reserva original.
 * O worker, e não o navegador, efetua a chamada Calendar e o commit final.
 */
export async function iniciarReagendamentoPixPago({
  pool, firestore, uid, agendamentoId, servicoId, data, horario,
  duracao, servico, agendamento, operationId, observacoes = "", dependencies = {},
}) {
  if (!UUID.test(operationId || "")) {
    throw new ErroReagendamentoPago(400, "Chave de reagendamento inválida");
  }
  if (!ATIVOS.has(agendamento.status) || !agendamento.pixCobrancaId) {
    throw new ErroReagendamentoPago(409, "Agendamento não está ativo com PIX pago");
  }
  if (agendamento.alteracaoServicoOperacaoPendente || agendamento.reagendamentoPixOperacaoPendente) {
    throw new ErroReagendamentoPago(409, "Outra alteração deste agendamento está em andamento");
  }
  if (String(agendamento.idServico || "") !== servicoId) {
    throw new ErroReagendamentoPago(409, "Reagendamento não permite trocar o serviço");
  }
  const eventId = String(agendamento.calendarEventId || "");
  if (!eventId) {
    throw new ErroReagendamentoPago(409, "Identificador do evento Calendar ausente");
  }
  const origemData = String(agendamento.data || "");
  const origemHorario = String(agendamento.horario || "");
  const origemInicio = minutos(origemHorario);
  const inicio = minutos(horario);
  const origemDuracao = Number(agendamento.duracaoSnapshot ?? agendamento.duracao);
  if (!Number.isSafeInteger(origemDuracao) || origemDuracao <= 0 ||
      inicio + origemDuracao > 1440 || origemInicio + origemDuracao > 1440 ||
      duracao !== origemDuracao) {
    throw new ErroReagendamentoPago(409, "Duração original divergente; confira o serviço");
  }
  if (origemData === data && origemInicio === inicio) {
    return { agendamentoId, estado: "concluida", reagendado: false, idempotente: true };
  }
  const nomeCliente = String(agendamento.nomeCliente || "Cliente").trim().slice(0, 120);
  const servicoNome = String(agendamento.servico || servico.nome || "Serviço").trim().slice(0, 120);
  const db = firestore || await firestorePadrao();
  const conexao = await pool.connect();
  try {
    await conexao.query("BEGIN");
    await bloquearDatas(conexao, [origemData, data]);

    const existente = await conexao.query(\`
      SELECT *, TO_CHAR(destino_data, 'YYYY-MM-DD') AS destino_data_iso
      FROM public.pix_reagendamentos_pagos WHERE operation_id = $1 FOR UPDATE
    \`, [operationId]);
    if (existente.rowCount) {
      const op = existente.rows[0];
      if (!destinoIgual(op, agendamentoId, uid, servicoId, data, inicio)) {
        throw new ErroReagendamentoPago(409, "Chave já utilizada para outro reagendamento");
      }
      await conexao.query("COMMIT");
      return { agendamentoId, operationId, estado: op.estado, reagendado: op.estado === "concluida" };
    }

    const pendente = await conexao.query(\`
      SELECT operation_id FROM public.pix_reagendamentos_pagos
      WHERE agendamento_id = $1 AND estado <> 'concluida'
      LIMIT 1 FOR UPDATE
    \`, [agendamentoId]);
    if (pendente.rowCount) {
      throw new ErroReagendamentoPago(409, "Há um reagendamento em processamento para este atendimento");
    }
    const cancelando = await conexao.query(\`
      SELECT 1 FROM public.agendamento_cancelamentos
      WHERE agendamento_id = $1 AND estado IN ('solicitada','concluida')
      LIMIT 1
    \`, [agendamentoId]);
    if (cancelando.rowCount) {
      throw new ErroReagendamentoPago(409, "Cancelamento em andamento para este atendimento");
    }

    const registro = await conexao.query(\`
      SELECT r.id, r.cliente_uid, r.servico_id, r.cobranca_id, r.agendamento_id,
             r.estado, r.inicio_minuto, r.fim_minuto,
             TO_CHAR(r.data_servico, 'YYYY-MM-DD') AS data_iso,
             c.cliente_uid AS cobranca_cliente_uid,
             c.agendamento_id AS cobranca_agendamento_id,
             c.estado AS cobranca_estado,
             o.event_id AS outbox_event_id, o.status AS outbox_estado
      FROM public.pix_reservas r
      JOIN public.pix_cobrancas c ON c.id = r.cobranca_id
      LEFT JOIN public.pix_calendar_outbox o ON o.agendamento_id = r.agendamento_id
      WHERE r.agendamento_id = $1
      FOR UPDATE OF r, c
    \`, [agendamentoId]);
    const reserva = registro.rows[0];
    const validacao = validarPagamentoPixReagendamento({
      agendamento, reserva, agendamentoId, servicoId,
    });
    if (!validacao.valido ||
        reserva?.outbox_event_id !== eventId ||
        reserva?.outbox_estado !== "enviado" ||
        reserva?.data_iso !== origemData ||
        Number(reserva?.inicio_minuto) !== origemInicio ||
        Number(reserva?.fim_minuto) !== origemInicio + origemDuracao) {
      throw new ErroReagendamentoPago(409, "PIX, reserva e evento original precisam estar conciliados");
    }

    if (await (dependencies.possuiBloqueio || possuiBloqueio)(
      conexao, data, inicio, inicio + origemDuracao,
    )) {
      throw new ErroReagendamentoPago(409, "Agenda fechada pela profissional no novo horário");
    }

    const sobrepostos = await conexao.query(\`
      SELECT 1 FROM public.pix_reservas
      WHERE data_servico = $1
        AND estado IN ('reservada', 'confirmada')
        AND agendamento_id IS DISTINCT FROM $4
        AND int4range(inicio_minuto, fim_minuto, '[)') &&
            int4range($2, $3, '[)')
      LIMIT 1
    \`, [data, inicio, inicio + origemDuracao, agendamentoId]);
    if (sobrepostos.rowCount) {
      throw new ErroReagendamentoPago(409, "Novo horário reservado por outra cliente");
    }

    // Revalida ocupação do Firestore antes de confirmar o bloqueio do novo horário.
    const docs = await db.collection("agendamentos").where("data", "==", data).get();
    const outros = docs.docs
      .filter((doc) => doc.id !== agendamentoId)
      .map((doc) => doc.data());
    if (encontrarConflitoAgendamentoPix(outros, inicio, inicio + origemDuracao)) {
      throw new ErroReagendamentoPago(409, "Novo horário ocupado por outro agendamento");
    }

    let holdId = null;
    const origemFim = origemInicio + origemDuracao;
    const destinoFim = inicio + origemDuracao;
    if (origemData === data && inicio < origemFim && destinoFim > origemInicio) {
      // Em horários sobrepostos, proteger a união evita conflito com a própria
      // reserva e impede outro agendamento de ocupar a parte adicional.
      const inicioUniao = Math.min(origemInicio, inicio);
      const fimUniao = Math.max(origemFim, destinoFim);
      const ajuste = await conexao.query(\`
        UPDATE public.pix_reservas
        SET inicio_minuto = $2, fim_minuto = $3, atualizado_em = NOW()
        WHERE id = $1 AND cobranca_id = $4 AND estado = 'confirmada'
        RETURNING id
      \`, [reserva.id, inicioUniao, fimUniao, reserva.cobranca_id]);
      if (!ajuste.rowCount) throw new ErroReagendamentoPago(409, "Reserva alterada por outra operação");
    } else {
      // Proteger o destino e preservar integralmente a origem.
      holdId = randomUUID();
      await conexao.query(\`
        INSERT INTO public.pix_reservas (
          id, cliente_uid, servico_id, data_servico, inicio_minuto, fim_minuto,
          estado, vence_em, cobranca_id, agendamento_id
        ) VALUES ($1, $2, $3, $4, $5, $6,
                  'confirmada', NOW() + INTERVAL '365 days', NULL, $7)
      \`, [holdId, agendamento.clienteId, servicoId, data, inicio, destinoFim,
        "pix_reag_hold_" + operationId]);
    }

    await conexao.query(\`
      INSERT INTO public.pix_reagendamentos_pagos (
        operation_id, agendamento_id, solicitante_uid, cliente_uid,
        servico_id, reserva_id, cobranca_id, calendar_event_id,
        nome_cliente, servico_nome, observacoes,
        origem_data, origem_inicio, origem_fim,
        destino_data, destino_inicio, destino_fim, hold_reserva_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11,
        $12, $13, $14, $15, $16, $17, $18
      )
    \`, [operationId, agendamentoId, uid, agendamento.clienteId,
      servicoId, reserva.id, reserva.cobranca_id, eventId, nomeCliente,
      servicoNome, String(observacoes || "").slice(0, 1000),
      origemData, origemInicio, origemFim, data, inicio, destinoFim, holdId]);

    await conexao.query("COMMIT");
    return { agendamentoId, operationId, estado: "solicitada", reagendado: false };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    if (erro?.code === "23P01" || erro?.code === "23505") {
      throw new ErroReagendamentoPago(409, "Novo horário ocupado ou reagendamento simultâneo");
    }
    throw erro;
  } finally {
    conexao.release();
  }
}

async function aplicarFirestore(op, db, dependencies) {
  const FieldValue = dependencies.FieldValue || await fieldValuePadrao();
  const ref = db.collection("agendamentos").doc(op.agendamento_id);
  const destinoData = op.destino_data_iso;
  const destinoHora = hora(Number(op.destino_inicio));
  const origemData = op.origem_data_iso;
  const origemHora = hora(Number(op.origem_inicio));
  const duracao = Number(op.origem_fim) - Number(op.origem_inicio);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ErroReagendamentoPago(409, "Agendamento excluído após bloqueio PIX");
    const atual = snap.data();
    if (atual.reagendamentoPixOperacaoId === op.operation_id &&
        atual.data === destinoData && atual.horario === destinoHora) return;
    if (!ATIVOS.has(atual.status) ||
        atual.reagendamentoPixOperacaoPendente && atual.reagendamentoPixOperacaoPendente !== op.operation_id ||
        atual.alteracaoServicoOperacaoPendente ||
        atual.clienteId !== op.cliente_uid ||
        atual.pixCobrancaId !== op.cobranca_id ||
        atual.idServico !== op.servico_id ||
        atual.calendarEventId !== op.calendar_event_id ||
        atual.data !== origemData || atual.horario !== origemHora) {
      throw new ErroReagendamentoPago(409, "Agendamento alterado durante sincronização; revisão necessária");
    }

    const destino = await tx.get(db.collection("agendamentos").where("data", "==", destinoData));
    const outros = destino.docs.filter((item) => item.id !== op.agendamento_id).map((item) => item.data());
    if (encontrarConflitoAgendamentoPix(outros, Number(op.destino_inicio), Number(op.destino_fim))) {
      throw new ErroReagendamentoPago(409, "Outro agendamento ocupa o novo horário");
    }
    tx.update(ref, {
      data: destinoData,
      horario: destinoHora,
      status: "reagendado",
      duracao,
      duracaoSnapshot: duracao,
      observacoes: op.observacoes,
      reagendadoEm: FieldValue.serverTimestamp(),
      reagendadoPor: op.solicitante_uid,
      reagendamentoPixOperacaoPendente: op.operation_id,
      reagendamentoPixOperacaoId: op.operation_id,
      // Não tocar em pixCobrancaId, pixReservaId, valores ou situação financeira.
    });
  });
}

async function concluirBanco(op, pool) {
  const con = await pool.connect();
  try {
    await con.query("BEGIN");
    await bloquearDatas(con, [op.origem_data_iso, op.destino_data_iso]);
    const reserva = await con.query(\`
      SELECT r.id, r.cobranca_id, r.agendamento_id, r.estado,
             c.estado AS cobranca_estado
      FROM public.pix_reservas r
      JOIN public.pix_cobrancas c ON c.id = r.cobranca_id
      WHERE r.id = $1 FOR UPDATE OF r, c
    \`, [op.reserva_id]);
    const atual = reserva.rows[0];
    if (!atual || atual.cobranca_id !== op.cobranca_id ||
        atual.agendamento_id !== op.agendamento_id ||
        atual.estado !== "confirmada" || atual.cobranca_estado !== "paga") {
      throw new ErroReagendamentoPago(409, "Pagamento ou reserva divergente após Calendar");
    }
    if (op.hold_reserva_id) {
      await con.query(\`
        UPDATE public.pix_reagendamentos_pagos
        SET hold_reserva_id = NULL, atualizado_em = NOW()
        WHERE operation_id = $1 AND estado = 'calendar_enviado'
      \`, [op.operation_id]);
      const limpeza = await con.query(\`
        DELETE FROM public.pix_reservas
        WHERE id = $1 AND agendamento_id = $2 AND cobranca_id IS NULL
        RETURNING id
      \`, [op.hold_reserva_id, "pix_reag_hold_" + op.operation_id]);
      if (!limpeza.rowCount) throw new ErroReagendamentoPago(409, "Proteção do novo horário ausente");
    }
    const mudanca = await con.query(\`
      UPDATE public.pix_reservas SET
        data_servico = $2, inicio_minuto = $3, fim_minuto = $4,
        atualizado_em = NOW()
      WHERE id = $1 AND cobranca_id = $5 AND estado = 'confirmada'
      RETURNING id
    \`, [op.reserva_id, op.destino_data_iso, op.destino_inicio,
      op.destino_fim, op.cobranca_id]);
    if (!mudanca.rowCount) throw new ErroReagendamentoPago(409, "Reserva paga não pôde ser movida");

    await con.query(\`
      UPDATE public.pix_reagendamentos_pagos
      SET estado = 'concluida', bloqueado_ate = NULL, ultimo_erro = NULL,
          concluido_em = NOW(), atualizado_em = NOW()
      WHERE operation_id = $1 AND estado = 'calendar_enviado'
    \`, [op.operation_id]);
    await con.query("COMMIT");
  } catch (erro) {
    await con.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    con.release();
  }
}

async function limparMarcador(op, pool, db, dependencies) {
  const FieldValue = dependencies.FieldValue || await fieldValuePadrao();
  const ref = db.collection("agendamentos").doc(op.agendamento_id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data()?.reagendamentoPixOperacaoPendente === op.operation_id) {
      tx.update(ref, { reagendamentoPixOperacaoPendente: FieldValue.delete() });
    }
  });
  await pool.query(\`
    UPDATE public.pix_reagendamentos_pagos
    SET limpeza_pendente = FALSE, ultimo_erro = NULL, bloqueado_ate = NULL,
        atualizado_em = NOW()
    WHERE operation_id = $1 AND estado = 'concluida'
  \`, [op.operation_id]);
}

async function processarOperacao(op, pool, dependencies = {}) {
  const db = dependencies.firestore || await firestorePadrao();
  if (op.estado === "solicitada") {
    const payload = montarPayloadReagendamentoPix({
      eventId: op.calendar_event_id, operationId: op.operation_id,
      nomeCliente: op.nome_cliente, servico: op.servico_nome,
      data: op.destino_data_iso, horario: hora(Number(op.destino_inicio)),
      duracao: Number(op.destino_fim) - Number(op.destino_inicio),
    });
    await (dependencies.enviarCalendar ||
      ((dados) => enviarReagendamentoPix(dados, fetch, URL_APPS_SCRIPT)))(payload);
    await pool.query(\`
      UPDATE public.pix_reagendamentos_pagos
      SET estado = 'calendar_enviado', atualizado_em = NOW()
      WHERE operation_id = $1 AND estado = 'solicitada'
    \`, [op.operation_id]);
    op.estado = "calendar_enviado";
  }
  if (op.estado === "calendar_enviado") {
    await aplicarFirestore(op, db, dependencies);
    await concluirBanco(op, pool);
    op.estado = "concluida";
  }
  if (op.estado === "concluida" && op.limpeza_pendente) {
    await limparMarcador(op, pool, db, dependencies);
  }
  return { estado: "concluida", operationId: op.operation_id };
}

export async function processarProximoReagendamentoPixPago(pool, dependencies = {}) {
  const claimed = await pool.query(\`
    WITH proxima AS (
      SELECT operation_id FROM public.pix_reagendamentos_pagos
      WHERE (
        (estado <> 'concluida' AND proxima_tentativa_em <= NOW()) OR
        (estado = 'concluida' AND limpeza_pendente = TRUE AND proxima_tentativa_em <= NOW())
      ) AND (bloqueado_ate IS NULL OR bloqueado_ate <= NOW())
      ORDER BY criado_em FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE public.pix_reagendamentos_pagos AS fila
    SET bloqueado_ate = NOW() + INTERVAL '2 minutes',
        tentativas = tentativas + 1, atualizado_em = NOW()
    FROM proxima
    WHERE fila.operation_id = proxima.operation_id
    RETURNING fila.*, TO_CHAR(fila.origem_data, 'YYYY-MM-DD') AS origem_data_iso,
                      TO_CHAR(fila.destino_data, 'YYYY-MM-DD') AS destino_data_iso
  \`);
  const op = claimed.rows[0];
  if (!op) return { processado: false };
  try {
    const result = await processarOperacao(op, pool, dependencies);
    return { processado: true, ...result };
  } catch (erro) {
    console.error("[PIX Reagendamento] Pendente de reconciliação:", op.operation_id, erro.message);
    await pool.query(\`
      UPDATE public.pix_reagendamentos_pagos
      SET bloqueado_ate = NULL,
          proxima_tentativa_em = NOW() + INTERVAL '60 seconds',
          ultimo_erro = $2, atualizado_em = NOW()
      WHERE operation_id = $1
    \`, [op.operation_id, String(erro?.message || "Erro de sincronização").slice(0, 300)]);
    return { processado: true, estado: "pendente", operationId: op.operation_id };
  }
}

export async function consultarReagendamentoPixPago({ pool, uid, operationId }) {
  if (!UUID.test(operationId || "")) throw new ErroReagendamentoPago(400, "Operação inválida");
  const op = await buscarOperacao(pool, operationId, uid);
  if (!op) throw new ErroReagendamentoPago(404, "Reagendamento não encontrado");
  return {
    operationId, agendamentoId: op.agendamento_id, estado: op.estado,
    reagendado: op.estado === "concluida",
    ...(op.ultimo_erro ? { processamentoPendente: true } : {}),
  };
}

export function iniciarWorkerReagendamentoPixPago(pool, dependencies = {}) {
  let ocupado = false;
  async function executar() {
    if (ocupado) return;
    ocupado = true;
    try { await processarProximoReagendamentoPixPago(pool, dependencies); }
    catch (erro) { console.error("[PIX Reagendamento] Worker indisponível:", erro.message); }
    finally { ocupado = false; }
  }
  const timer = setInterval(executar, 5000);
  timer.unref?.();
  void executar();
  return () => clearInterval(timer);
}
