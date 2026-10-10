import { validarRetornoPagamentoPix } from "./pixValidacaoPagamento.js";

export function classificarReservaAposCredito(
  estado,
  venceEm,
  agendamentoId,
  agora = Date.now()
) {
  if (estado === "confirmada" && agendamentoId) {
    return {
      situacao: "agendamento_confirmado",
      agendamentoConfirmado: true
    };
  }

  if (
    estado === "reservada" &&
    Number.isFinite(new Date(venceEm).getTime()) &&
    new Date(venceEm).getTime() > agora
  ) {
    return {
      situacao: "pago_aguardando_agendamento",
      agendamentoConfirmado: false
    };
  }

  return {
    situacao: "pago_requer_analise",
    agendamentoConfirmado: false
  };
}

export async function registrarCreditoPix({
  pool,
  cobrancaId,
  uid,
  pedido
}) {
  if (
    typeof cobrancaId !== "string" ||
    typeof uid !== "string" ||
    !uid
  ) {
    throw new Error("Identificacao financeira invalida");
  }

  const conexao = await pool.connect();

  try {
    await conexao.query("BEGIN");

    const consulta = await conexao.query(`
      SELECT
        c.id,
        c.estado,
        c.mp_order_id,
        c.referencia_externa,
        c.valor_sinal_centavos,
        r.estado AS reserva_estado,
        r.vence_em AS reserva_vence_em,
        r.agendamento_id
      FROM public.pix_cobrancas AS c
      JOIN public.pix_reservas AS r
        ON r.cobranca_id = c.id
      WHERE c.id = $1
        AND c.cliente_uid = $2
        AND r.cliente_uid = $2
      FOR UPDATE OF c, r
    `, [cobrancaId, uid]);

    const cobranca = consulta.rows[0];

    if (!cobranca) {
      throw new Error("Cobranca nao encontrada");
    }

    const validacao = validarRetornoPagamentoPix(
      pedido,
      cobranca
    );

    if (!validacao.creditado) {
      throw new Error("Pagamento ainda nao creditado");
    }

    // Um pagamento anteriormente estornado exige analise.
    // Nao podemos reverter um estorno com uma consulta antiga.
    if (cobranca.estado === "estornada") {
      await conexao.query("COMMIT");

      return {
        situacao: "revisao_financeira",
        agendamentoConfirmado: false
      };
    }

    // COALESCE preserva o primeiro registro de credito.
    await conexao.query(`
      UPDATE public.pix_cobrancas
      SET
        estado = 'paga',
        pago_em = COALESCE(pago_em, NOW()),
        atualizado_em = NOW()
      WHERE id = $1
    `, [cobrancaId]);

    // A chave unica impede eventos duplicados.
    await conexao.query(`
      INSERT INTO public.pix_eventos (
        cobranca_id,
        chave_evento,
        tipo,
        mp_order_id
      )
      VALUES ($1, $2, 'pagamento_creditado', $3)
      ON CONFLICT (chave_evento) DO NOTHING
    `, [
      cobrancaId,
      `mercadopago:credito:${pedido.pedidoId}`,
      pedido.pedidoId
    ]);

    const situacao = classificarReservaAposCredito(
      cobranca.reserva_estado,
      cobranca.reserva_vence_em,
      cobranca.agendamento_id
    );

    await conexao.query("COMMIT");

    return situacao;
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    conexao.release();
  }
}

export async function encerrarCobrancaPixSemPagamento({
  pool,
  cobrancaId,
  uid,
  situacao
}) {
  const estados = {
    expirada: { cobranca: "expirada", reserva: "expirada" },
    cancelada: { cobranca: "cancelada", reserva: "cancelada" }
  };
  const destino = estados[situacao];

  if (!destino || typeof cobrancaId !== "string" || !uid) {
    throw new Error("Encerramento da cobranca invalido");
  }

  const conexao = await pool.connect();
  try {
    await conexao.query("BEGIN");
    const consulta = await conexao.query(`
      SELECT c.estado, r.estado AS reserva_estado
      FROM public.pix_cobrancas c
      JOIN public.pix_reservas r ON r.cobranca_id = c.id
      WHERE c.id = $1 AND c.cliente_uid = $2 AND r.cliente_uid = $2
      FOR UPDATE OF c, r
    `, [cobrancaId, uid]);
    const atual = consulta.rows[0];

    if (!atual) throw new Error("Cobranca nao encontrada");

    if (
      atual.estado === "paga" ||
      atual.estado === "estornada" ||
      atual.reserva_estado === "confirmada"
    ) {
      await conexao.query("COMMIT");
      return {
        situacao: atual.estado === "paga"
          ? "pago_requer_analise"
          : "revisao_financeira",
        agendamentoConfirmado: false
      };
    }

    await conexao.query(`
      UPDATE public.pix_cobrancas
      SET estado = $2, atualizado_em = NOW()
      WHERE id = $1
    `, [cobrancaId, destino.cobranca]);
    await conexao.query(`
      UPDATE public.pix_reservas
      SET estado = $2, atualizado_em = NOW()
      WHERE cobranca_id = $1 AND estado = 'reservada'
    `, [cobrancaId, destino.reserva]);
    await conexao.query(`
      INSERT INTO public.pix_eventos (cobranca_id, chave_evento, tipo, mp_order_id)
      SELECT id, $2, $3, mp_order_id
      FROM public.pix_cobrancas WHERE id = $1
      ON CONFLICT (chave_evento) DO NOTHING
    `, [cobrancaId, `mercadopago:${situacao}:${cobrancaId}`, situacao]);
    await conexao.query("COMMIT");
    return { situacao, agendamentoConfirmado: false };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    conexao.release();
  }
}
