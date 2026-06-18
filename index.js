const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Função agendada para rodar a cada 15 minutos
 */
exports.scheduledReminderCheck = functions.pubsub
  .schedule("every 15 minutes")
  .onRun(async (context) => {
    const agora = new Date().toISOString();

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
