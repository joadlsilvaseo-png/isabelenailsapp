const URL_MP = "https://api.mercadopago.com";

function valorEmReais(centavos) {
  if (!Number.isSafeInteger(centavos) || centavos <= 0) {
    throw new Error("Valor PIX invalido");
  }

  const reais = Math.floor(centavos / 100);
  const centavosRestantes = String(centavos % 100).padStart(2, "0");

  return `${reais}.${centavosRestantes}`;
}

export function montarPedidoPix({
  valorCentavos,
  referenciaExterna,
  chaveIdempotencia,
  emailPagador,
  prazoMinutos = 30
}) {
  if (
    typeof referenciaExterna !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(referenciaExterna)
  ) {
    throw new Error("Referencia externa invalida");
  }

  if (
    typeof chaveIdempotencia !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(chaveIdempotencia)
  ) {
    throw new Error("Chave de idempotencia invalida");
  }

  if (
    typeof emailPagador !== "string" ||
    emailPagador.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailPagador)
  ) {
    throw new Error("Email do pagador invalido");
  }

  if (
    !Number.isInteger(prazoMinutos) ||
    prazoMinutos < 30 ||
    prazoMinutos > 60
  ) {
    throw new Error("Prazo PIX invalido");
  }

  const valor = valorEmReais(valorCentavos);

  return {
    type: "online",
    processing_mode: "automatic",
    external_reference: referenciaExterna,
    total_amount: valor,
    payer: {
      email: emailPagador
    },
    transactions: {
      payments: [
        {
          amount: valor,
          payment_method: {
            id: "pix",
            type: "bank_transfer"
          },
          expiration_time: `PT${prazoMinutos}M`
        }
      ]
    }
  };
}

async function requisitarMercadoPago(caminho, opcoes = {}) {
  const token = process.env.MP_ACCESS_TOKEN_TEST?.trim();

  if (!token || !token.startsWith("APP_USR-")) {
    throw new Error("Credencial de teste do Mercado Pago ausente");
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
  };

  if (opcoes.corpo) {
    headers["Content-Type"] = "application/json";
  }

  if (opcoes.idempotencia) {
    headers["X-Idempotency-Key"] = opcoes.idempotencia;
  }

  const resposta = await fetch(`${URL_MP}${caminho}`, {
    method: opcoes.metodo || "GET",
    headers,
    ...(opcoes.corpo
      ? { body: JSON.stringify(opcoes.corpo) }
      : {}),
    signal: AbortSignal.timeout(15000)
  });

  if (!resposta.ok) {
    throw new Error(
      `Falha na API do Mercado Pago: HTTP ${resposta.status}`
    );
  }

  return resposta.json();
}

function resumirPedido(pedido) {
  const pagamento = pedido?.transactions?.payments?.[0];

  if (
    typeof pedido?.id !== "string" ||
    !pedido.id
  ) {
    throw new Error("Mercado Pago retornou pedido sem identificador");
  }

  return {
    pedidoId: pedido.id,
    referenciaExterna: pedido.external_reference,
    valorPedido: pedido.total_amount,
    statusPedido: pedido.status,
    detalhePedido: pedido.status_detail,
    statusPagamento: pagamento?.status || null,
    detalhePagamento: pagamento?.status_detail || null,
    valorPagamento: pagamento?.amount || null,
    pix: {
      copiaECola: pagamento?.payment_method?.qr_code || null,
      qrCodeBase64:
        pagamento?.payment_method?.qr_code_base64 || null,
      urlInstrucoes:
        pagamento?.payment_method?.ticket_url || null
    }
  };
}

export function pixFoiCreditado(pedido) {
  const pagamento = pedido?.transactions?.payments?.[0];

  return (
    pedido?.status === "processed" &&
    pagamento?.status === "processed" &&
    pagamento?.status_detail === "accredited"
  );
}

export async function criarPedidoPixTeste(dados) {
  const corpo = montarPedidoPix(dados);

  const pedido = await requisitarMercadoPago("/v1/orders", {
    metodo: "POST",
    corpo,
    idempotencia: dados.chaveIdempotencia
  });

  return resumirPedido(pedido);
}

export async function consultarPedidoPixTeste(pedidoId) {
  if (
    typeof pedidoId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(pedidoId)
  ) {
    throw new Error("Identificador do pedido invalido");
  }

  const pedido = await requisitarMercadoPago(
    `/v1/orders/${encodeURIComponent(pedidoId)}`
  );

  return resumirPedido(pedido);
}