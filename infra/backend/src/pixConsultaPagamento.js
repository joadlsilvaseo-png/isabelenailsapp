import { verificarUsuario } from "./pushSubscriptions.js";
import { consultarPedidoPixTeste } from "./pixMercadoPago.js";
import { validarRetornoPagamentoPix } from "./pixValidacaoPagamento.js";

function responder(res, codigo, dados) {
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(dados));
}

export async function consultarStatusPagamentoPix(req, res, pool) {
  let uid;

  try {
    uid = await verificarUsuario(req);
  } catch {
    responder(res, 401, { erro: "Nao autenticado" });
    return;
  }

  try {
    if (process.env.PIX_TEST_ORDERS_ENABLED !== "true") {
      responder(res, 409, { erro: "PIX ainda desativado" });
      return;
    }

    const partes = [];
    let tamanho = 0;

    for await (const parte of req) {
      tamanho += parte.length;

      if (tamanho > 2048) {
        responder(res, 413, { erro: "Requisicao muito grande" });
        return;
      }

      partes.push(parte);
    }

    let dados;

    try {
      dados = JSON.parse(
        Buffer.concat(partes).toString("utf8")
      );
    } catch {
      responder(res, 400, { erro: "JSON invalido" });
      return;
    }

    const reservaId = dados?.reservaId;

    if (
      typeof reservaId !== "string" ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
        .test(reservaId)
    ) {
      responder(res, 400, { erro: "Reserva invalida" });
      return;
    }

    const consulta = await pool.query(`
      SELECT
        c.mp_order_id,
        c.referencia_externa,
        c.valor_sinal_centavos,
        r.estado AS estado_reserva
      FROM public.pix_reservas AS r
      JOIN public.pix_cobrancas AS c
        ON c.id = r.cobranca_id
      WHERE r.id = $1
        AND r.cliente_uid = $2
        AND c.cliente_uid = $2
    `, [reservaId, uid]);

    const cobranca = consulta.rows[0];

    if (!cobranca) {
      responder(res, 404, { erro: "Reserva nao encontrada" });
      return;
    }

    if (!cobranca.mp_order_id) {
      responder(res, 202, {
        situacao: "cobranca_em_preparacao",
        agendamentoConfirmado: false
      });
      return;
    }

    const pedido = await consultarPedidoPixTeste(
      cobranca.mp_order_id
    );

    const resultado = validarRetornoPagamentoPix(
      pedido,
      cobranca
    );

    responder(res, 200, {
      situacao: resultado.situacao,
      pagamentoCreditado: resultado.creditado,
      agendamentoConfirmado: false,
      mensagem: resultado.creditado
        ? "Pagamento identificado. Confirmacao do agendamento pendente."
        : "Pagamento ainda nao confirmado."
    });
  } catch (erro) {
    console.error("[PIX Status]", erro.message);

    responder(res, 503, {
      erro: "Nao foi possivel verificar o pagamento"
    });
  }
}