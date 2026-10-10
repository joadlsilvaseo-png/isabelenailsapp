import { consultarPedidoPix } from "./pixMercadoPago.js";
import { processarProximaNotificacaoPix } from "./pixWebhookFila.js";
import { validarRetornoPagamentoPix } from "./pixValidacaoPagamento.js";
import { encerrarCobrancaPixSemPagamento, registrarCreditoPix, registrarEstornoPix } from "./pixConciliacao.js";
import { efetivarAgendamentoPix } from "./pixEfetivacao.js";

const pausar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function atualizarMarcadorFirestore(agendamentoId, dados) {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  await getFirestore().collection("agendamentos").doc(agendamentoId).update(dados);
}

export async function processarOrderNotificada(pool, pedidoId, ambiente, dependencias = {}) {
  const consultarPedido = dependencias.consultarPedido || consultarPedidoPix;
  const pedido = await consultarPedido(pedidoId, ambiente);
  const consulta = await pool.query(`SELECT c.* FROM public.pix_cobrancas c
    WHERE c.mp_order_id = $1 AND c.mp_environment = $2`, [pedidoId, ambiente]);
  const cobranca = consulta.rows[0];
  if (!cobranca) return { concluido: false, tentarNovamenteEmSegundos: 300 };
  if (pedido.pedidoId !== cobranca.mp_order_id || pedido.referenciaExterna !== cobranca.referencia_externa) {
    throw new Error("Order nao corresponde a cobranca persistida");
  }
  const resultado = (dependencias.validarPagamento || validarRetornoPagamentoPix)(pedido, cobranca);
  if (resultado.creditado) {
    const conciliacao = await (dependencias.registrarCredito || registrarCreditoPix)({
      pool, cobrancaId: cobranca.id, uid: cobranca.cliente_uid, pedido
    });
    if (["pago_aguardando_agendamento", "agendamento_confirmado", "pago_requer_analise"].includes(conciliacao.situacao)) {
      try {
        await (dependencias.efetivarAgendamento || efetivarAgendamentoPix)({
          pool, cobrancaId: cobranca.id, uid: cobranca.cliente_uid
        });
      } catch (erro) {
        if (!erro?.requerAnalise) throw erro;
        console.error("[PIX Webhook Worker] Pagamento creditado requer conciliacao:", cobranca.id);
      }
    }
    return { concluido: true };
  }
  if (["expirada", "cancelada", "recusada"].includes(resultado.situacao)) {
    await (dependencias.encerrarCobranca || encerrarCobrancaPixSemPagamento)({
      pool, cobrancaId: cobranca.id, uid: cobranca.cliente_uid, situacao: resultado.situacao
    });
    return { concluido: true };
  }
  if (resultado.situacao === "estornada") {
    await (dependencias.registrarEstorno || registrarEstornoPix)({
      pool, cobrancaId: cobranca.id, pedido,
      atualizarFirestore: dependencias.atualizarFirestore || atualizarMarcadorFirestore
    });
    return { concluido: true };
  }
  if (resultado.situacao === "revisao_financeira") {
    return { concluido: true };
  }
  return { concluido: false, tentarNovamenteEmSegundos: 180 };
}

export function iniciarWorkerPixWebhook(pool, processarOrder = (id, env) => processarOrderNotificada(pool, id, env)) {
  let encerrado = false;
  const executar = async () => {
    while (!encerrado) {
      try {
        const resultado = await processarProximaNotificacaoPix(pool, processarOrder);
        if (resultado.situacao === "vazia") await pausar(1500);
      } catch (erro) {
        console.error("[PIX Webhook Worker] Falha temporaria:", erro.message);
        await pausar(3000);
      }
    }
  };
  if (process.env.PIX_TEST_ORDERS_ENABLED !== "true" && process.env.PIX_PRODUCTION_ORDERS_ENABLED !== "true") {
    console.log("[PIX Webhook Worker] Ambiente ativo desabilitado; worker nao iniciado.");
    return () => { encerrado = true; };
  }
  executar();
  return () => { encerrado = true; };
}
