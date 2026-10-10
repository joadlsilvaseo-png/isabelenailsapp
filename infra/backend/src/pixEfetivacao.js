import {
  initializeApp,
  applicationDefault,
  getApps
} from "firebase-admin/app";

import { getAuth } from "firebase-admin/auth";

import {
  confirmarAgendamentoPixNoFirestore
} from "./pixConfirmacaoFirestore.js";

import {
  gerarIdAgendamentoPix,
  validarReservaVigentePix
} from "./pixRegrasConfirmacao.js";

function requerAnalise(mensagem) {
  return Object.assign(new Error(mensagem), {
    requerAnalise: true
  });
}

export async function efetivarAgendamentoPix({
  pool,
  cobrancaId,
  uid
}) {
  const conexao = await pool.connect();

  try {
    await conexao.query("BEGIN");

    // A linha da reserva fica bloqueada enquanto ocorre
    // a confirmacao. Chamadas concorrentes aguardam.
    const resultado = await conexao.query(`
      SELECT
        c.*,
        r.id AS reserva_id,
        r.cobranca_id AS reserva_cobranca_id,
        r.cliente_uid AS reserva_cliente_uid,
        r.servico_id AS reserva_servico_id,
        r.estado AS reserva_estado,
        r.vence_em AS reserva_vence_em,
        r.inicio_minuto,
        r.fim_minuto,
        r.agendamento_id AS reserva_agendamento_id,
        TO_CHAR(r.data_servico, 'YYYY-MM-DD') AS reserva_data_iso
      FROM public.pix_cobrancas c
      JOIN public.pix_reservas r
        ON r.cobranca_id = c.id
      WHERE c.id = $1
        AND c.cliente_uid = $2
        AND r.cliente_uid = $2
      FOR UPDATE OF c, r
    `, [cobrancaId, uid]);

    const registro = resultado.rows[0];

    if (!registro) {
      throw requerAnalise("Cobranca ou reserva nao encontrada");
    }

    if (
      registro.estado !== "paga" ||
      !registro.mp_order_id ||
      !registro.pago_em
    ) {
      throw requerAnalise("Pagamento nao conciliado");
    }

    const agendamentoIdEsperado =
      gerarIdAgendamentoPix(registro.id);

    if (
      registro.reserva_agendamento_id &&
      registro.reserva_agendamento_id !== agendamentoIdEsperado
    ) {
      throw requerAnalise("Vinculo do agendamento divergente");
    }

    const reserva = {
      id: registro.reserva_id,
      cobranca_id: registro.reserva_cobranca_id,
      cliente_uid: registro.reserva_cliente_uid,
      servico_id: registro.reserva_servico_id,
      estado: registro.reserva_estado,
      vence_em: registro.reserva_vence_em,
      inicio_minuto: registro.inicio_minuto,
      fim_minuto: registro.fim_minuto,
      data_iso: registro.reserva_data_iso
    };

    if (
      !["reservada", "confirmada"]
        .includes(reserva.estado)
    ) {
      throw requerAnalise("Reserva indisponivel");
    }

    if (reserva.estado === "reservada") {
      try {
        validarReservaVigentePix(reserva);
      } catch {
        throw requerAnalise(
          "Pagamento creditado com reserva vencida"
        );
      }
    }

    if (!getApps().length) {
      initializeApp({
        credential: applicationDefault(),
        projectId: "isabele-nails-app"
      });
    }

    const usuario = await getAuth().getUser(uid);

    const nomeCliente =
      usuario.displayName ||
      registro.reserva_dados?.nomeCliente ||
      "Cliente";

    // ID deterministico: repetir nao cria outro documento.
    const confirmado =
      await confirmarAgendamentoPixNoFirestore({
        cobranca: registro,
        reserva,
        nomeCliente
      });

    if (
      !["agendado", "reagendado", "confirmado", "concluido"]
        .includes(confirmado.status)
    ) {
      throw requerAnalise(
        "Estado do agendamento requer analise"
      );
    }

    await conexao.query(`
      UPDATE public.pix_reservas
      SET estado = 'confirmada',
          agendamento_id = $2,
          atualizado_em = NOW()
      WHERE id = $1
    `, [reserva.id, confirmado.agendamentoId]);

    await conexao.query(`
      UPDATE public.pix_cobrancas
      SET agendamento_id = $2,
          atualizado_em = NOW()
      WHERE id = $1
    `, [registro.id, confirmado.agendamentoId]);

    await conexao.query(`
      INSERT INTO public.pix_eventos (
        cobranca_id,
        chave_evento,
        tipo,
        mp_order_id
      )
      VALUES ($1, $2, 'agendamento_confirmado', $3)
      ON CONFLICT (chave_evento) DO NOTHING
    `, [
      registro.id,
      `isabele:agendamento:${registro.id}`,
      registro.mp_order_id
    ]);

    await conexao.query("COMMIT");

    return {
      situacao: "agendamento_confirmado",
      agendamentoConfirmado: true,
      agendamentoId: confirmado.agendamentoId
    };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    conexao.release();
  }
}