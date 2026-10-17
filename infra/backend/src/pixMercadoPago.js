const URL_MP = "https://api.mercadopago.com";

export class ErroMercadoPago extends Error {
  constructor(status, retryAfterSeconds) {
    super(`Falha na API do Mercado Pago: HTTP ${status}`);
    this.name = "ErroMercadoPago";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function ambienteMercadoPagoAtual() {
  const ambiente = (process.env.MP_ENVIRONMENT || "test").trim().toLowerCase();
  if (!["test", "production"].includes(ambiente)) {
    throw new Error("MP_ENVIRONMENT deve ser test ou production");
  }
  return ambiente;
}

export function mercadoPagoHabilitado(ambiente = ambienteMercadoPagoAtual()) {
  if (ambiente === "test") return process.env.PIX_TEST_ORDERS_ENABLED === "true";
  if (ambiente === "production") {
    return process.env.PIX_PRODUCTION_ORDERS_ENABLED === "true" &&
      Boolean(process.env.MP_ACCESS_TOKEN_PRODUCTION?.trim());
  }
  return false;
}

function tokenValido(token, ambiente) {
  if (!token) return false;
  return ambiente === "test"
    ? /^(APP_USR-|TEST-)/.test(token)
    : token.startsWith("APP_USR-");
}

function obterToken(ambiente) {
  const nome = ambiente === "production"
    ? "MP_ACCESS_TOKEN_PRODUCTION"
    : "MP_ACCESS_TOKEN_TEST";
  const token = process.env[nome]?.trim();
  if (!tokenValido(token, ambiente)) {
    throw new Error(`Credencial do Mercado Pago ausente para ${ambiente}`);
  }
  return token;
}

function valorEmReais(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos <= 0) throw new Error("Valor PIX invalido");
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, "0")}`;
}

export function montarPedidoPix({ valorCentavos, referenciaExterna, chaveIdempotencia, emailPagador, prazoMinutos = 30, ambiente = ambienteMercadoPagoAtual() }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(referenciaExterna || "")) throw new Error("Referencia externa invalida");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chaveIdempotencia || "")) throw new Error("Chave de idempotencia invalida");
  if (typeof emailPagador !== "string" || emailPagador.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPagador)) throw new Error("Email do pagador invalido");
  if (!Number.isInteger(prazoMinutos) || prazoMinutos < 30 || prazoMinutos > 60) throw new Error("Prazo PIX invalido");
  if (!["test", "production"].includes(ambiente)) throw new Error("Ambiente Mercado Pago invalido");
  const valor = valorEmReais(valorCentavos);
  return {
    type: "online",
    processing_mode: "automatic",
    external_reference: referenciaExterna,
    total_amount: valor,
    payer: { email: emailPagador, ...(ambiente === "test" ? { first_name: "APRO" } : {}) },
    transactions: { payments: [{ amount: valor, payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: `PT${prazoMinutos}M` }] }
  };
}

async function requisitarMercadoPago(caminho, opcoes = {}, ambiente = ambienteMercadoPagoAtual()) {
  if (!mercadoPagoHabilitado(ambiente)) throw new Error(`Operacoes PIX desativadas para ${ambiente}`);
  const token = obterToken(ambiente);
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (opcoes.corpo) headers["Content-Type"] = "application/json";
  if (opcoes.idempotencia) headers["X-Idempotency-Key"] = opcoes.idempotencia;
  let resposta;
  try {
    resposta = await fetch(`${URL_MP}${caminho}`, {
      method: opcoes.metodo || "GET", headers,
      ...(opcoes.corpo ? { body: JSON.stringify(opcoes.corpo) } : {}),
      signal: AbortSignal.timeout(15000)
    });
  } catch (erro) {
    // O erro é tipado sem incorporar a URL autenticada, headers ou token.
    const falha = new Error("Falha de rede ao consultar Mercado Pago");
    falha.name = erro?.name === "AbortError" || erro?.name === "TimeoutError" ? "TimeoutError" : "ErroRedeMercadoPago";
    falha.code = erro?.code;
    throw falha;
  }
  if (!resposta.ok) {
    const retryHeader = resposta.headers?.get?.("retry-after");
    let retryAfterSeconds = Number(retryHeader);
    if (!Number.isFinite(retryAfterSeconds) && retryHeader) {
      const instante = Date.parse(retryHeader);
      if (Number.isFinite(instante)) retryAfterSeconds = Math.max(0, (instante - Date.now()) / 1000);
    }
    throw new ErroMercadoPago(
      resposta.status,
      Number.isFinite(retryAfterSeconds) ? Math.min(2147483647, retryAfterSeconds) : undefined,
    );
  }
  return resposta.json();
}

function resumirPedido(pedido) {
  const pagamento = pedido?.transactions?.payments?.[0];
  if (typeof pedido?.id !== "string" || !pedido.id) throw new Error("Mercado Pago retornou pedido sem identificador");
  return {
    pedidoId: pedido.id, referenciaExterna: pedido.external_reference,
    valorPedido: pedido.total_amount, statusPedido: pedido.status,
    detalhePedido: pedido.status_detail, statusPagamento: pagamento?.status || null,
    detalhePagamento: pagamento?.status_detail || null, valorPagamento: pagamento?.amount || null,
    pix: { copiaECola: pagamento?.payment_method?.qr_code || null, qrCodeBase64: pagamento?.payment_method?.qr_code_base64 || null, urlInstrucoes: pagamento?.payment_method?.ticket_url || null }
  };
}

export function pixFoiCreditado(pedido) {
  const pagamento = pedido?.transactions?.payments?.[0];
  return pedido?.status === "processed" && pagamento?.status === "processed" && pagamento?.status_detail === "accredited";
}

export async function criarPedidoPix(dados, ambiente = ambienteMercadoPagoAtual()) {
  const corpo = montarPedidoPix({ ...dados, ambiente });
  return resumirPedido(await requisitarMercadoPago("/v1/orders", { metodo: "POST", corpo, idempotencia: dados.chaveIdempotencia }, ambiente));
}

export async function consultarPedidoPix(pedidoId, ambiente = ambienteMercadoPagoAtual()) {
  if (typeof pedidoId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(pedidoId)) throw new Error("Identificador do pedido invalido");
  return resumirPedido(await requisitarMercadoPago(`/v1/orders/${encodeURIComponent(pedidoId)}`, {}, ambiente));
}

export async function consultarPedidoPixComLock(pool, pedidoId, ambiente = ambienteMercadoPagoAtual(), consulta = consultarPedidoPix) {
  const conexao = await pool.connect();
  const chave = `${ambiente}:${pedidoId}`;
  let bloqueado = false;
  try {
    const resultado = await conexao.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS adquirido",
      [chave],
    );
    bloqueado = resultado.rows[0]?.adquirido === true;
    if (!bloqueado) {
      const erro = new Error("Consulta da cobrança já está em andamento");
      erro.code = "PIX_CONSULTA_EM_ANDAMENTO";
      throw erro;
    }
    await aguardarQuotaGlobalMercadoPago(conexao);
    return await consulta(pedidoId, ambiente);
  } finally {
    if (bloqueado) {
      await conexao.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [chave],
      ).catch(() => {});
    }
    conexao.release();
  }
}

async function aguardarQuotaGlobalMercadoPago(conexao) {
  const limite = Number.parseInt(process.env.PIX_POLLING_MAX_REQUESTS_PER_MINUTE || "12", 10);
  const requestsPorMinuto = Number.isInteger(limite) ? Math.max(1, Math.min(60, limite)) : 12;
  while (true) {
    let aguardarMs = 0;
    try {
      await conexao.query("BEGIN");
      const resultado = await conexao.query(`
        SELECT window_started_at, request_count
        FROM public.pix_polling_request_budget
        WHERE id = 1
        FOR UPDATE
      `);
      const janela = resultado.rows[0];
      if (!janela) throw new Error("Quota global Mercado Pago não inicializada");
      const iniciouEm = new Date(janela.window_started_at).getTime();
      const agora = Date.now();
      if (!Number.isFinite(iniciouEm) || agora - iniciouEm >= 60000) {
        await conexao.query(`
          UPDATE public.pix_polling_request_budget
          SET window_started_at = NOW(), request_count = 1
          WHERE id = 1
        `);
      } else if (Number(janela.request_count) < requestsPorMinuto) {
        await conexao.query(`
          UPDATE public.pix_polling_request_budget
          SET request_count = request_count + 1
          WHERE id = 1
        `);
      } else {
        aguardarMs = Math.max(100, 60000 - (agora - iniciouEm));
      }
      await conexao.query("COMMIT");
    } catch (erro) {
      await conexao.query("ROLLBACK").catch(() => {});
      throw erro;
    }
    if (!aguardarMs) return;
    await new Promise((resolve) => setTimeout(resolve, aguardarMs));
  }
}

// Compatibilidade com chamadas antigas enquanto todas as rotas usam ambiente explícito.
export const criarPedidoPixTeste = (dados) => criarPedidoPix(dados, "test");
export const consultarPedidoPixTeste = (pedidoId) => consultarPedidoPix(pedidoId, "test");
