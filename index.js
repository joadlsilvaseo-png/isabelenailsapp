const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Inicialização do Firebase Admin SDK (mantida intacta)
admin.initializeApp();
const db = admin.firestore();

/**
 * Função agendada para rodar a cada 15 minutos
 */
exports.scheduledReminderCheck = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async (context) => {
    // A função processReminders já usa new Date().toISOString() internamente

    // 1. Processar Lembretes de 24 horas
    await processReminders(
      "reminder_24h",
      "push_24h_sent",
      "Seu agendamento é amanhã! 💅",
    );

    // 2. Processar Lembretes de 2 horas
    await processReminders(
      "reminder_2h",
      "push_2h_sent",
      "Faltam apenas 2 horas para seu horário! ✨",
    );

    return null;
  });

// Função auxiliar processReminders (mantida intacta)
async function processReminders(timeField, statusField, messageTitle) {
  const agora = new Date().toISOString();

  // Busca agendamentos que atingiram o tempo e não foram notificados
  const snapshot = await db
    .collection("agendamentos")
    .where(timeField, "<=", agora)
    .where(statusField, "==", false)
    .where("status", "==", "confirmado")
    .get();

  if (snapshot.empty) return;

  for (const doc of snapshot.docs) {
    const agendamento = doc.data();
    const userId = agendamento.clienteId;

    // Busca o token FCM do usuário
    const subSnap = await db.collection("fcmTokens").doc(userId).get();

    if (subSnap.exists) {
      const subData = subSnap.data();
      const fcmToken = subData.token;

      const message = {
        notification: {
          title: messageTitle,
          body: `Olá! Lembrando do seu serviço de ${agendamento.servico} às ${agendamento.horario}.`,
        },
        data: {
          url: "/meu-perfil.html",
        },
        token: fcmToken,
      };

      try {
        await admin.messaging().send(message);

        // Marca como enviado no agendamento para evitar duplicidade
        await doc.ref.update({ [statusField]: true });
        console.log(`Lembrete FCM ${timeField} enviado para usuário ${userId}`);
      } catch (error) {
        console.error("Erro ao enviar FCM:", error);
        // Se o token for inválido, o Firebase retorna um erro específico.
        // Em produção, você pode tratar 'messaging/registration-token-not-registered' para deletar o subSnap.
      }
    }
  }
}

/**
 * NOVA CLOUD FUNCTION: processNotificationEvent
 * Escuta a criação de documentos na coleção 'eventos_notificacao'
 * e envia uma notificação push FCM para o cliente.
 */
exports.processNotificationEvent = functions.firestore
  .document("eventos_notificacao/{eventId}")
  .onCreate(async (snap, context) => {
    const eventData = snap.data();
    const { tipo, clienteId, agendamentoId } = eventData;

    if (!clienteId) {
      console.log(`Evento ${snap.id}: clienteId não encontrado. Ignorando.`);
      return null;
    }

    // 1. Buscar token FCM do cliente
    const fcmTokenSnap = await db.collection("fcmTokens").doc(clienteId).get();
    if (!fcmTokenSnap.exists) {
      console.log(
        `Evento ${snap.id}: Token FCM para cliente ${clienteId} não encontrado. Encerrando.`,
      );
      return null;
    }
    const fcmToken = fcmTokenSnap.data().token;

    // 2. Criar mensagem baseada no tipo de evento
    let notificationTitle = "Isabele Mariana Nails";
    let notificationBody = "Você tem uma nova atualização!";
    const targetUrl = "/meu-perfil.html"; // URL padrão para todos os eventos

    switch (tipo) {
      case "agendamento_criado":
        notificationTitle = "Agendamento Confirmado! 🎉";
        notificationBody = `Seu agendamento #${agendamentoId} foi confirmado.`;
        break;
      case "agendamento_reagendado":
        notificationTitle = "Agendamento Reagendado! 🗓️";
        notificationBody = `Seu agendamento #${agendamentoId} foi reagendado. Verifique os novos detalhes.`;
        break;
      case "cancelamento_cliente":
        notificationTitle = "Agendamento Cancelado ❌";
        notificationBody = `Você cancelou o agendamento #${agendamentoId}.`;
        break;
      case "cancelamento_admin":
        notificationTitle = "Agendamento Cancelado 🚫";
        notificationBody = `Seu agendamento #${agendamentoId} foi cancelado pela profissional. Entre em contato para mais detalhes.`;
        break;
      default:
        console.warn(
          `Evento ${snap.id}: Tipo de notificação desconhecido: ${tipo}.`,
        );
        return null;
    }

    const message = {
      notification: { title: notificationTitle, body: notificationBody },
      data: {
        agendamentoId: agendamentoId || "N/A",
        tipo: tipo || "N/A",
        url: targetUrl,
      },
      token: fcmToken,
    };

    // 3. Enviar notificação push e atualizar status do evento
    try {
      await admin.messaging().send(message);
      console.log(
        `Evento ${snap.id}: Notificação push enviada com sucesso para ${clienteId}.`,
      );
      await snap.ref.update({
        processado: true,
        processadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`Evento ${snap.id}: Marcado como processado.`);
    } catch (error) {
      console.error(
        `Evento ${snap.id}: Erro ao enviar notificação ou atualizar status:`,
        error,
      );
      // Opcional: Adicionar lógica para reprocessamento ou registro de erro no evento
    }
    return null;
  });
