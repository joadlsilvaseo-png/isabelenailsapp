function emCentavos(valor) {
  if (
    valor === null ||
    valor === undefined ||
    !/^\d+(?:\.\d{1,2})?$/.test(String(valor))
  ) {
    return null;
  }

  const [inteiro, decimal = ""] = String(valor).split(".");
  const resultado =
    Number(inteiro) * 100 +
    Number(decimal.padEnd(2, "0"));

  return Number.isSafeInteger(resultado) ? resultado : null;
}

export function validarRetornoPagamentoPix(pedido, cobranca) {
  const valorEsperado = Number(cobranca.valor_sinal_centavos);

  if (
    !Number.isSafeInteger(valorEsperado) ||
    valorEsperado <= 0 ||
    !cobranca.mp_order_id ||
    pedido?.pedidoId !== cobranca.mp_order_id ||
    pedido?.referenciaExterna !== cobranca.referencia_externa ||
    emCentavos(pedido?.valorPedido) !== valorEsperado
  ) {
    throw new Error("Divergencia entre pedido e cobranca");
  }

  if (
    pedido.valorPagamento != null &&
    emCentavos(pedido.valorPagamento) !== valorEsperado
  ) {
    throw new Error("Valor da transacao divergente");
  }

  const creditado =
    pedido.statusPedido === "processed" &&
    pedido.detalhePedido === "accredited" &&
    pedido.statusPagamento === "processed" &&
    pedido.detalhePagamento === "accredited";

  if (creditado && emCentavos(pedido.valorPagamento) !== valorEsperado) {
    throw new Error("Pagamento sem valor creditado valido");
  }

  let situacao = "revisao_financeira";

  if (creditado) {
    situacao = "creditado_aguardando_confirmacao";
  } else if (
    ["created", "processing", "action_required"].includes(
      pedido.statusPedido
    )
  ) {
    situacao = "aguardando_pagamento";
  }

  return { creditado, situacao };
}