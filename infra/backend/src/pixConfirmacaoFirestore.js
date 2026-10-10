import {
  initializeApp,
  applicationDefault,
  getApps
} from "firebase-admin/app";

import {
  getFirestore,
  FieldValue
} from "firebase-admin/firestore";

import { validarHorarioPix } from "./pixDisponibilidade.js";

import {
  encontrarConflitoAgendamentoPix,
  montarAgendamentoPix
} from "./pixDocumentoAgendamento.js";

import {
  gerarIdAgendamentoPix,
  validarVinculoConfirmacaoPix,
  validarReservaVigentePix
} from "./pixRegrasConfirmacao.js";

function firestore() {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: "isabele-nails-app"
    });
  }

  return getFirestore();
}

// Uso interno do backend.
// O chamador deve verificar e bloquear a cobranca no PostgreSQL
// antes de executar esta operacao.
export async function confirmarAgendamentoPixNoFirestore({
  cobranca,
  reserva,
  nomeCliente
}) {
  validarVinculoConfirmacaoPix(cobranca, reserva);

  const banco = firestore();

  // O mesmo pagamento sempre produz o mesmo documento.
  const agendamentoId = gerarIdAgendamentoPix(cobranca.id);

  const referencia = banco
    .collection("agendamentos")
    .doc(agendamentoId);

  return banco.runTransaction(async (transacao) => {
    const existente = await transacao.get(referencia);

    if (existente.exists) {
      const dados = existente.data();

      if (
        dados.pixCobrancaId !== cobranca.id ||
        dados.pixReservaId !== reserva.id ||
        dados.clienteId !== cobranca.cliente_uid
      ) {
        throw new Error(
          "Documento existente nao pertence a cobranca"
        );
      }

      // Um agendamento cancelado nao pode ser reativado por
      // uma nova consulta ao pagamento.
      if (
        !["agendado", "reagendado", "confirmado", "concluido"]
          .includes(dados.status)
      ) {
        throw new Error(
          "Agendamento PIX existente exige analise"
        );
      }

      // Nao recria nem altera agendamentos ja existentes.
      return {
        agendamentoId,
        criado: false,
        status: dados.status
      };
    }

    if (reserva.estado === "confirmada") {
      throw new Error(
        "Reserva confirmada sem documento no Firestore"
      );
    }

    const horario = validarReservaVigentePix(reserva);

    const duracao =
      reserva.fim_minuto - reserva.inicio_minuto;

    const periodo = validarHorarioPix(
      reserva.data_iso,
      horario,
      duracao
    );

    if (!periodo.valido) {
      throw new Error(periodo.motivo);
    }

    const consulta = banco
      .collection("agendamentos")
      .where("data", "==", reserva.data_iso);

    // Todas as leituras ocorrem antes da gravacao.
    const existentes = await transacao.get(consulta);

    const conflito = encontrarConflitoAgendamentoPix(
      existentes.docs.map((documento) => documento.data()),
      reserva.inicio_minuto,
      reserva.fim_minuto
    );

    if (conflito) {
      throw new Error(
        "Pagamento creditado, mas horario ocupado: requer analise"
      );
    }

    const documento = montarAgendamentoPix({
      cobranca,
      reserva,
      nomeCliente
    });

    transacao.create(referencia, {
      ...documento,
      calendarEventId: `evt_${agendamentoId}`,
      dataCriacao: FieldValue.serverTimestamp(),
      confirmadoEm: FieldValue.serverTimestamp()
    });

    return {
      agendamentoId,
      criado: true,
      status: "confirmado"
    };
  });
}