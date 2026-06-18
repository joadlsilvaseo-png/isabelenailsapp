const functions = require("firebase-functions");
const admin = require("firebase-admin");
const webpush = require("web-push");

admin.initializeApp();
const db = admin.firestore();

webpush.setVapidDetails(
  "mailto:contato@isabelenails.com.br",
  "BIsX3O0M9_X_8u3v4N_S5P_R9x2Y7Z6x5W4v3U2t1s0r9Q8P7O6N5M4L3K2J1I0H9G8F7E",
  process.env.VAPID_PRIVATE_KEY, // Chave privada vinda das variáveis de ambiente
);

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
    const userId = agendamento.idCliente;

    // Busca a subscrição de push do usuário
    const subSnap = await db.collection("pushSubscriptions").doc(userId).get();

    if (subSnap.exists) {
      const subData = subSnap.data();
      const pushSubscription = {
        endpoint: subData.endpoint,
        keys: subData.keys,
      };

      const payload = JSON.stringify({
        title: messageTitle,
        body: `Olá! Lembrando do seu serviço de ${agendamento.servico} às ${agendamento.horario}.`,
        url: "/meu-perfil.html",
      });

      try {
        await webpush.sendNotification(pushSubscription, payload);

        // Marca como enviado no agendamento para evitar duplicidade
        await doc.ref.update({ [statusField]: true });
        console.log(`Lembrete ${timeField} enviado para usuário ${userId}`);
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          // Subscrição expirada ou inválida, removemos do banco
          console.log("Subscrição expirada, removendo...");
          await subSnap.ref.delete();
        } else {
          console.error("Erro ao enviar push:", error);
        }
      }
    }
  }
}
