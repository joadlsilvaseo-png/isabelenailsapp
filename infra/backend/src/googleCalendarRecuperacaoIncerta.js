/**
 * Recuperacao de uma escrita incerta (timeout) apenas para eventos VPS.
 * Nunca repete POST, PATCH ou DELETE: consulta events.get e, caso o
 * comprovante seja inequivoco, finaliza somente o banco via transacao.
 *
 * Nao possui rota, worker, timer ou efeitos na importacao.
 */
import { gerarIdEventoGoogle } from "./googleCalendarEvents.js";
import { concluirOperacaoGoogleConfirmada } from "./googleCalendarRegistroConfirmado.js";

function erro(codigo) {
  return Object.assign(new Error("Recuperacao Calendar recusada: " + codigo), { codigo });
}

/**
 * Contrato para futura orquestracao:
 * 1) operação existe com estado aguardando_confirmacao
 * 2) remoto ainda precisa ser inspecionado; a ausencia nao autoriza retry
 * 3) comprovante Google confirmado resulta em transacao idempotente.
 */
export async function verificarOperacaoGoogleIncerta({
  pool, adaptador, operationId, fingerprint, calendarId, env = process.env,
} = {}) {
  if (env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true" ||
      env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED !== "true" ||
      env.GOOGLE_CALENDAR_CUTOVER_ENABLED !== "true") {
    throw erro("CUTOVER_DESATIVADO");
  }
  if (!pool?.query || !adaptador?.consultarEvento ||
      typeof operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId) ||
      typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint) ||
      typeof calendarId !== "string" || !calendarId || /\s/.test(calendarId)) {
    throw erro("PARAMETROS_INVALIDOS");
  }

  const consulta = await pool.query(
    `SELECT operation_id, agendamento_id, calendar_id, tipo, google_event_id,
            fingerprint_pedido, estado
     FROM public.google_calendar_sync_operations WHERE operation_id = $1`,
    [operationId],
  );
  const op = consulta.rows?.[0];
  if (!op) throw erro("OPERACAO_NAO_ENCONTRADA");
  if (op.calendar_id !== calendarId ||
      String(op.fingerprint_pedido).trim() !== fingerprint) {
    throw erro("OPERACAO_DIVERGENTE");
  }
  if (op.estado !== "aguardando_confirmacao") {
    throw erro("OPERACAO_ESTADO_INCOMPATIVEL");
  }
  if (!["criar", "reagendar", "alterar_servico"].includes(op.tipo)) {
    throw erro("TIPO_RECUPERACAO_NAO_SUPORTADO");
  }

  const eventId = op.tipo === "criar"
    ? gerarIdEventoGoogle(op.agendamento_id)
    : op.google_event_id;
  if (!eventId || (op.google_event_id && op.google_event_id !== eventId)) {
    throw erro("EVENTO_DIVERGENTE");
  }
  // NUNCA gerar um novo ID caso events.get nao encontre o anterior.
  const evento = await adaptador.consultarEvento({ eventId });
  if (!evento) {
    return {
      estado: "ainda_sem_confirmacao",
      aguardandoRevisao: true, eventId,
      criouEvento: false, repetiuEscrita: false,
    };
  }
  // O registro seguinte revalida a operacao, o marcador e o fingerprint
  // dentro de uma transacao FOR UPDATE antes de concluir.
  const confirmacao = await concluirOperacaoGoogleConfirmada({
    pool, operationId, fingerprint, evento, calendarId, env,
  });
  return {
    estado: "confirmada_no_google",
    aguardandoRevisao: false,
    ...confirmacao,
    criouEvento: false, repetiuEscrita: false,
  };
}
