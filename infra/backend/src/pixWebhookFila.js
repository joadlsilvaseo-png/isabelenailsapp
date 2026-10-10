const TEMPO_LEASE_SEGUNDOS = 300;

export async function processarProximaNotificacaoPix(pool, processarOrder) {
  if (!pool || typeof pool.query !== "function" || typeof processarOrder !== "function") {
    throw new TypeError("Dependencias da fila invalidas");
  }
  const retirada = await pool.query(`
    WITH proxima AS (
      SELECT mp_environment, mp_order_id
      FROM public.pix_webhook_inbox
      WHERE processado_em IS NULL AND proxima_tentativa_em <= NOW()
      ORDER BY proxima_tentativa_em, mp_environment, mp_order_id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE public.pix_webhook_inbox AS fila
    SET tentativas = fila.tentativas + 1,
        proxima_tentativa_em = NOW() + ($1 * INTERVAL '1 second'),
        ultimo_erro = NULL
    FROM proxima
    WHERE fila.mp_environment = proxima.mp_environment
      AND fila.mp_order_id = proxima.mp_order_id
    RETURNING fila.mp_environment, fila.mp_order_id, fila.tentativas,
      fila.ultima_notificacao_em
  `, [TEMPO_LEASE_SEGUNDOS]);
  const item = retirada.rows[0];
  if (!item) return { situacao: "vazia" };
  const condicao = `WHERE mp_environment = $1 AND mp_order_id = $2
    AND ultima_notificacao_em = $3 AND processado_em IS NULL`;
  try {
    const resultado = await processarOrder(item.mp_order_id, item.mp_environment);
    if (!resultado || typeof resultado.concluido !== "boolean") throw new Error("Retorno do processador invalido");
    if (resultado.concluido) {
      const gravado = await pool.query(`UPDATE public.pix_webhook_inbox
        SET processado_em = NOW(), ultimo_erro = NULL ${condicao}`,
      [item.mp_environment, item.mp_order_id, item.ultima_notificacao_em]);
      return { situacao: gravado.rowCount ? "concluida" : "atualizada" };
    }
    const segundos = Math.min(3600, Math.max(60,
      Number.isFinite(resultado.tentarNovamenteEmSegundos)
        ? Math.trunc(resultado.tentarNovamenteEmSegundos) : 300));
    const adiada = await pool.query(`UPDATE public.pix_webhook_inbox
      SET proxima_tentativa_em = NOW() + ($4 * INTERVAL '1 second'),
        ultimo_erro = NULL ${condicao}`,
    [item.mp_environment, item.mp_order_id, item.ultima_notificacao_em, segundos]);
    return { situacao: adiada.rowCount ? "adiada" : "atualizada" };
  } catch (erro) {
    const segundos = Math.min(3600, 30 * (2 ** Math.min(item.tentativas, 7)));
    const remarcada = await pool.query(`UPDATE public.pix_webhook_inbox
      SET proxima_tentativa_em = NOW() + ($4 * INTERVAL '1 second'),
        ultimo_erro = $5 ${condicao}`,
    [item.mp_environment, item.mp_order_id, item.ultima_notificacao_em, segundos,
      String(erro?.name || "ErroDeProcessamento").slice(0, 80)]);
    return { situacao: remarcada.rowCount ? "reagendada" : "atualizada" };
  }
}
