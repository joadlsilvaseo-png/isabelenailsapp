const URL_APPS_SCRIPT = "https://script.google.com/macros/s/AKfycbzOxH8NT960XH0HSmuq5MPDzXkijMVVymGAWD_8_eFcNzfTKfadnnoy-plj_GCtPCnFcw/exec";

function obterDataIso(evento) {
  // Na fila real, o SELECT entrega um alias formatado pelo PostgreSQL.
  const data = evento.data_servico_iso ?? evento.data_servico;
  if (typeof data === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data)) return data;
  if (data instanceof Date && Number.isFinite(data.getTime())) {
    // Fallback para chamadas/testes que recebam Date: usa componentes UTC,
    // nunca a representação textual local da data.
    return [
      String(data.getUTCFullYear()).padStart(4, "0"),
      String(data.getUTCMonth() + 1).padStart(2, "0"),
      String(data.getUTCDate()).padStart(2, "0")
    ].join("-");
  }
  throw new Error("Data do evento Calendar invalida");
}

export function montarPayloadCalendar(evento) {
  return {
    acao: "AGENDAR",
    nomeCliente: evento.nome_cliente,
    servico: evento.servico,
    dataInicio: `${obterDataIso(evento)}T${String(evento.horario).slice(0, 5)}:00`,
    duracaoMinutos: Number(evento.duracao_minutos),
    eventId: evento.event_id
  };
}

export function montarPayloadCancelamentoCalendar(evento) {
  return {
    acao: "CANCELAR",
    eventId: evento.calendar_event_id
  };
}

async function enviarAcaoCalendar(payload, fetcher = fetch) {
  const resposta = await fetcher(URL_APPS_SCRIPT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!resposta.ok) throw new Error(`Apps Script respondeu HTTP ${resposta.status}`);
  const texto = typeof resposta.text === "function" ? await resposta.text() : "";
  if (texto.trim()) {
    let corpo;
    try { corpo = JSON.parse(texto); } catch { corpo = null; }
    if (corpo && typeof corpo === "object") {
      const status = String(corpo.status || "").toLowerCase();
      if (
        corpo.ok === false || corpo.success === false || corpo.sucesso === false ||
        corpo.error || corpo.erro || ["error", "erro", "falha", "failed"].includes(status)
      ) throw new Error("Apps Script informou falha na sincronizacao");
    } else if (/exception|script function .* not found/i.test(texto)) {
      throw new Error("Apps Script informou falha na sincronizacao");
    }
  }
  return payload;
}

export async function enviarEventoCalendar(evento, fetcher = fetch) {
  const payload = montarPayloadCalendar(evento);
  return enviarAcaoCalendar(payload, fetcher);
}

export async function enviarCancelamentoCalendar(evento, fetcher = fetch) {
  const payload = montarPayloadCancelamentoCalendar(evento);
  if (!payload.eventId) throw new Error("Identificador do evento Calendar ausente");
  return enviarAcaoCalendar(payload, fetcher);
}

async function obterEventoPendente(pool) {
  const conexao = await pool.connect();
  try {
    await conexao.query("BEGIN");
    const resultado = await conexao.query(`
      WITH proximo AS (
        SELECT id
        FROM public.pix_calendar_outbox
        WHERE (status = 'pendente' AND proxima_tentativa_em <= NOW())
           OR (status = 'enviando' AND bloqueado_ate <= NOW())
        ORDER BY criado_em
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.pix_calendar_outbox AS fila
      SET status = 'enviando',
          tentativas = tentativas + 1,
          bloqueado_ate = NOW() + INTERVAL '1 minute',
          atualizado_em = NOW()
      FROM proximo
      WHERE fila.id = proximo.id
      RETURNING fila.*,
                TO_CHAR(fila.data_servico, 'YYYY-MM-DD') AS data_servico_iso
    `);
    await conexao.query("COMMIT");
    return resultado.rows[0] || null;
  } catch (erro) {
    // A entrega é at least once: timeout após uma gravação pode gerar retry
    // com o mesmo eventId. Evitar duplicidade externa depende do Apps Script
    // reutilizar esse ID; o código do script não está neste repositório.
    await conexao.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    conexao.release();
  }
}

export async function processarProximaSincronizacaoCalendar(pool, enviar = enviarEventoCalendar) {
  const evento = await obterEventoPendente(pool);
  if (!evento) return { processado: false };
  try {
    await enviar(evento);
    await pool.query(`
      UPDATE public.pix_calendar_outbox
      SET status = 'enviado', enviado_em = NOW(), bloqueado_ate = NULL,
          ultimo_erro = NULL, atualizado_em = NOW()
      WHERE id = $1 AND status = 'enviando'
    `, [evento.id]);
    return { processado: true, enviado: true, eventId: evento.event_id };
  } catch (erro) {
    const atrasoSegundos = Math.min(3600, 30 * (2 ** Math.min(evento.tentativas - 1, 7)));
    await pool.query(`
      UPDATE public.pix_calendar_outbox
      SET status = 'pendente', bloqueado_ate = NULL,
          proxima_tentativa_em = NOW() + ($2::integer * INTERVAL '1 second'),
          ultimo_erro = $3, atualizado_em = NOW()
      WHERE id = $1 AND status = 'enviando'
    `, [evento.id, atrasoSegundos, String(erro?.message || "Falha de sincronizacao").slice(0, 300)]);
    return { processado: true, enviado: false, eventId: evento.event_id };
  }
}

async function obterCancelamentoCalendarPendente(pool) {
  const conexao = await pool.connect();
  try {
    await conexao.query("BEGIN");
    const resultado = await conexao.query(`
      WITH proximo AS (
        SELECT cancelamento.agendamento_id
        FROM public.agendamento_cancelamentos AS cancelamento
        WHERE cancelamento.estado = 'concluida'
          AND cancelamento.calendar_event_id IS NOT NULL
          AND (
            (cancelamento.calendar_estado = 'pendente'
              AND cancelamento.calendar_proxima_tentativa_em <= NOW())
            OR (cancelamento.calendar_estado = 'enviando'
              AND cancelamento.calendar_bloqueado_ate <= NOW())
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.pix_calendar_outbox AS criacao
            WHERE criacao.agendamento_id = cancelamento.agendamento_id
              AND criacao.status <> 'enviado'
          )
        ORDER BY cancelamento.criado_em
        FOR UPDATE OF cancelamento SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.agendamento_cancelamentos AS fila
      SET calendar_estado = 'enviando',
          calendar_tentativas = calendar_tentativas + 1,
          calendar_bloqueado_ate = NOW() + INTERVAL '1 minute',
          atualizado_em = NOW()
      FROM proximo
      WHERE fila.agendamento_id = proximo.agendamento_id
      RETURNING fila.*
    `);
    await conexao.query("COMMIT");
    return resultado.rows[0] || null;
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    conexao.release();
  }
}

export async function processarProximoCancelamentoCalendar(pool, enviar = enviarCancelamentoCalendar) {
  const evento = await obterCancelamentoCalendarPendente(pool);
  if (!evento) return { processado: false };
  try {
    await enviar(evento);
    await pool.query(`
      UPDATE public.agendamento_cancelamentos
      SET calendar_estado = 'enviado', calendar_enviado_em = NOW(),
          calendar_bloqueado_ate = NULL, calendar_ultimo_erro = NULL,
          atualizado_em = NOW()
      WHERE agendamento_id = $1 AND calendar_estado = 'enviando'
    `, [evento.agendamento_id]);
    return { processado: true, enviado: true, eventId: evento.calendar_event_id };
  } catch (erro) {
    const atraso = Math.min(3600, 30 * (2 ** Math.min(evento.calendar_tentativas - 1, 7)));
    await pool.query(`
      UPDATE public.agendamento_cancelamentos
      SET calendar_estado = 'pendente', calendar_bloqueado_ate = NULL,
          calendar_proxima_tentativa_em = NOW() + ($2::integer * INTERVAL '1 second'),
          calendar_ultimo_erro = $3, atualizado_em = NOW()
      WHERE agendamento_id = $1 AND calendar_estado = 'enviando'
    `, [evento.agendamento_id, atraso, String(erro?.message || "Falha ao cancelar evento").slice(0, 300)]);
    return { processado: true, enviado: false, eventId: evento.calendar_event_id };
  }
}

export function iniciarWorkerPixCalendar(pool) {
  let ocupado = false;
  const executar = async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      const resultado = await processarProximaSincronizacaoCalendar(pool);
      if (resultado.processado && !resultado.enviado) {
        console.warn("[PIX Calendar] Sincronizacao falhou; nova tentativa agendada.");
      }
      const cancelamento = await processarProximoCancelamentoCalendar(pool);
      if (cancelamento.processado && !cancelamento.enviado) {
        console.warn("[PIX Calendar] Cancelamento falhou; nova tentativa agendada.");
      }
    } catch (erro) {
      console.error("[PIX Calendar] Worker indisponivel:", erro.message);
    } finally {
      ocupado = false;
    }
  };
  const timer = setInterval(executar, 5000);
  timer.unref?.();
  executar();
  return () => clearInterval(timer);
}

