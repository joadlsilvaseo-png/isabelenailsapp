/**
 * Registro transacional de vinculacao de evento Google confirmado.
 * Somente eventos NOVOS com marcador privado isabele-vps.
 *
 * Este modulo NAO faz HTTP, nao inicia worker, nao grava ate invocacao
 * explicita e nao pode reconciliar eventos historicos do Apps Script.
 */
import { gerarIdEventoGoogle } from "./googleCalendarEvents.js";

function erro(codigo) {
  return Object.assign(new Error("Vinculo Google Calendar recusado: " + codigo), { codigo });
}
function texto(valor, max = 300) {
  return typeof valor === "string" && valor.length >= 1 && valor.length <= max &&
    !/[\r\n\t]/.test(valor);
}
function checkEvento(agendamentoId, evento, tipo) {
  if (!texto(agendamentoId, 128) || !/^[A-Za-z0-9_-]+$/.test(agendamentoId)) throw erro("AGENDAMENTO_INVALIDO");
  if (!evento || !texto(evento.id, 1024) ||
      !/^[A-Za-z0-9_-]+$/.test(evento.id) ||
      evento.id.length < 5 ||
      evento.extendedProperties?.private?.isabeleAgendamentoId !== agendamentoId ||
      evento.extendedProperties?.private?.isabeleOrigem !== "isabele-vps") {
    throw erro("EVENTO_NAO_VERIFICADO");
  }
  if (evento.status === "cancelled") throw erro("EVENTO_CANCELADO");
  if (tipo === "criar" && evento.id !== gerarIdEventoGoogle(agendamentoId)) {
    throw erro("EVENTO_ID_NAO_DETERMINISTICO");
  }
  return evento.id;
}

/**
 * Recebe comprovante retornado pelo Google API, mas exige verificacao adicional:
 * somente pode ser chamado no futuro por fluxo que usou access token e
 * events.get/insert; nunca por dados vindos do navegador.
 *
 * Guardas: flag independente, vinculacao tipada, transacao, uma operacao
 * ativa identificada por UUID + fingerprint e chave idempotente.
 * Em caso de conexao instavel: nenhuma tentativa automatica de escrita Google.
 */
export async function concluirOperacaoGoogleConfirmada({
  pool, operationId, fingerprint, evento, calendarId,
  env = process.env,
} = {}) {
  if (env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true" ||
      env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED !== "true" ||
      env.GOOGLE_CALENDAR_CUTOVER_ENABLED !== "true") {
    throw erro("CUTOVER_DESATIVADO");
  }
  if (!pool?.connect || typeof pool.connect !== "function" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId || "") ||
      !/^[a-f0-9]{64}$/.test(fingerprint || "") ||
      !texto(calendarId) || /\s/.test(calendarId)) {
    throw erro("PARAMETROS_INVALIDOS");
  }

  const con = await pool.connect();
  let transacao = false;
  try {
    await con.query("BEGIN");
    transacao = true;
    const res = await con.query(
      `SELECT operation_id, agendamento_id, calendar_id, tipo, google_event_id,
              fingerprint_pedido, estado
       FROM public.google_calendar_sync_operations
       WHERE operation_id = $1 FOR UPDATE`,
      [operationId],
    );
    const op = res.rows?.[0];
    if (!op) throw erro("OPERACAO_NAO_ENCONTRADA");
    if (op.calendar_id !== calendarId || String(op.fingerprint_pedido).trim() !== fingerprint) {
      throw erro("OPERACAO_DIVERGENTE");
    }
    const googleEventId = checkEvento(op.agendamento_id, evento, op.tipo);
    if (op.google_event_id && op.google_event_id !== googleEventId) {
      throw erro("EVENTO_DIVERGENTE");
    }
    if (op.estado === "concluida") {
      const linkResult = await con.query(
        `SELECT agendamento_id, calendar_id, google_event_id, origem, situacao
         FROM public.google_calendar_event_links WHERE agendamento_id = $1`,
        [op.agendamento_id],
      );
      const link = linkResult.rows?.[0];
      if (!link || link.calendar_id !== calendarId ||
          link.google_event_id !== googleEventId || link.origem !== "vps") {
        throw erro("RESULTADO_CONCLUIDO_DIVERGENTE");
      }
      await con.query("COMMIT");
      transacao = false;
      return { concluida: true, repetida: true, agendamentoId: op.agendamento_id, googleEventId };
    }
    if (!["processando", "aguardando_confirmacao"].includes(op.estado)) {
      throw erro("OPERACAO_ESTADO_INCOMPATIVEL");
    }

    // A ordem INSERT -> SELECT garante que uma colisao de UNIQUE tanto por
    // agendamento quanto por evento NUNCA substitui outro vinculo.
    await con.query(
      `INSERT INTO public.google_calendar_event_links
       (agendamento_id, calendar_id, google_event_id, origem,
        metodo_verificacao, verificado_em, verificado_por)
       VALUES ($1, $2, $3, 'vps', 'google_api', NOW(), 'api-google')
       ON CONFLICT DO NOTHING`,
      [op.agendamento_id, calendarId, googleEventId],
    );
    const atual = await con.query(
      `SELECT agendamento_id, calendar_id, google_event_id, origem, situacao
       FROM public.google_calendar_event_links WHERE agendamento_id = $1 FOR UPDATE`,
      [op.agendamento_id],
    );
    const link = atual.rows?.[0];
    if (!link || link.calendar_id !== calendarId ||
        link.google_event_id !== googleEventId || link.origem !== "vps" ||
        link.situacao !== "ativo") {
      throw erro("VINCULO_CONFLITANTE");
    }
    const atualizacao = await con.query(
      `UPDATE public.google_calendar_sync_operations
       SET estado = 'concluida', google_event_id = $2,
           concluido_em = NOW(), bloqueado_ate = NULL,
           ultimo_codigo_erro = NULL, atualizado_em = NOW()
       WHERE operation_id = $1
         AND estado IN ('processando', 'aguardando_confirmacao')
       RETURNING operation_id`,
      [operationId, googleEventId],
    );
    if (atualizacao.rows?.length !== 1) throw erro("OPERACAO_ALTERADA");

    await con.query("COMMIT");
    transacao = false;
    return { concluida: true, repetida: false, agendamentoId: op.agendamento_id, googleEventId };
  } catch (e) {
    if (transacao) await con.query("ROLLBACK");
    throw e;
  } finally {
    con.release();
  }
}
