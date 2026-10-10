const URL_APPS_SCRIPT = "https://script.google.com/macros/s/AKfycbwUwXunAdMAroSPAeMHH2ZQxCOuQage7lmAHH7-llgmeVXug6-Z9KGq6R7NVgQ70XYy/exec";

export function montarPayloadCalendar(evento) {
  return {
    acao: "AGENDAR",
    nomeCliente: evento.nome_cliente,
    servico: evento.servico,
    dataInicio: `${String(evento.data_servico).slice(0, 10)}T${String(evento.horario).slice(0, 5)}:00`,
    duracaoMinutos: Number(evento.duracao_minutos),
    eventId: evento.event_id
  };
}

export async function enviarEventoCalendar(evento, fetcher = fetch) {
  const payload = montarPayloadCalendar(evento);
  const resposta = await fetcher(URL_APPS_SCRIPT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!resposta.ok) throw new Error(`Apps Script respondeu HTTP ${resposta.status}`);
  return payload;
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
