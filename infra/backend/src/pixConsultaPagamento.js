import { consultarPedidoPixTeste } from "./pixMercadoPago.js";
import { validarRetornoPagamentoPix } from "./pixValidacaoPagamento.js";
import {
  encerrarCobrancaPixSemPagamento,
  registrarCreditoPix
} from "./pixConciliacao.js";
import { efetivarAgendamentoPix } from "./pixEfetivacao.js";

function responder(res, codigo, dados) {
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(dados));
}

export async function consultarStatusPagamentoPix(req, res, pool, dependencias = {}) {
  const autenticar = dependencias.verificarUsuario || (async (requisicao) => {
    const modulo = await import("./pushSubscriptions.js");
    return modulo.verificarUsuario(requisicao);
  });
  const consultarPedido = dependencias.consultarPedido || consultarPedidoPixTeste;
  const validarPagamento = dependencias.validarPagamento || validarRetornoPagamentoPix;
  const registrarCredito = dependencias.registrarCredito || registrarCreditoPix;
  const efetivarAgendamento = dependencias.efetivarAgendamento || efetivarAgendamentoPix;
  const encerrarCobranca = dependencias.encerrarCobranca || encerrarCobrancaPixSemPagamento;
  let uid;

  try {
    uid = await autenticar(req);
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
        c.id,
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

    const pedido = await consultarPedido(
      cobranca.mp_order_id
    );

    const resultado = validarPagamento(
      pedido,
      cobranca
    );

    if (resultado.creditado) {
      const conciliacao = await registrarCredito({
        pool,
        cobrancaId: cobranca.id,
        uid,
        pedido
      });

      let finalizacao = conciliacao;

      if (
        ["pago_aguardando_agendamento", "agendamento_confirmado", "pago_requer_analise"]
          .includes(conciliacao.situacao)
      ) {
        try {
          finalizacao = await efetivarAgendamento({
            pool,
            cobrancaId: cobranca.id,
            uid
          });
        } catch (erro) {
          console.error("[PIX Efetivacao]", erro.message);

          finalizacao = {
            situacao: erro?.requerAnalise
              ? "pago_requer_analise"
              : "pago_aguardando_agendamento",
            agendamentoConfirmado: false
          };
        }
      }

      responder(res, 200, {
        situacao: finalizacao.situacao,
        pagamentoCreditado: true,
        agendamentoConfirmado: finalizacao.agendamentoConfirmado,
        agendamentoId: finalizacao.agendamentoId || null,
        mensagem: finalizacao.agendamentoConfirmado
          ? "Agendamento confirmado."
          : "Pagamento identificado. Confirmacao do horario pendente."
      });
      return;
    }

    if (["expirada", "cancelada"].includes(resultado.situacao)) {
      const encerramento = await encerrarCobranca({
        pool,
        cobrancaId: cobranca.id,
        uid,
        situacao: resultado.situacao
      });
      responder(res, 200, {
        situacao: encerramento.situacao,
        pagamentoCreditado: false,
        agendamentoConfirmado: false,
        mensagem: encerramento.situacao === "expirada"
          ? "O prazo deste PIX terminou. Faça uma nova reserva."
          : "Esta cobrança foi cancelada. Faça uma nova reserva."
      });
      return;
    }

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
