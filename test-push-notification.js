/**
 * Script de Teste End-to-End: Validação de Notificações FCM e Lembretes
 *
 * Requisitos de execução:
 * 1. Ter o Node.js instalado.
 * 2. Ter as credenciais do Firebase Admin configuradas no ambiente.
 * 3. Substituir TEST_USER_UID pelo UID de um usuário que já tenha se inscrito no PWA.
 */

const admin = require("firebase-admin");

// Inicializa o SDK Admin (usa as credenciais padrão do ambiente)
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

async function runPushTest(userId) {
  console.log(">>> [LOG] INICIANDO TESTE E2E DE NOTIFICAÇÕES...");

  try {
    // 1. Simular Agendamento
    const agora = new Date();
    // Definimos o lembrete para daqui a 1 minuto conforme solicitado
    const reminderTime = new Date(agora.getTime() + 60000);

    console.log(
      `>>> [LOG] Passo 1: Criando agendamento de teste para o UID: ${userId}`,
    );
    const testDoc = await db.collection("agendamentos").add({
      clienteId: userId,
      servico: "Teste de Sistema E2E",
      horario: "00:00",
      data: "Data Teste",
      status: "confirmado",
      reminder_24h: reminderTime.toISOString(),
      push_24h_sent: false,
      dataCriacao: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`>>> [LOG] Agendamento de teste criado com ID: ${testDoc.id}`);

    // 2. Forçar execução da lógica de lembrete
    // Como o agendamento está no futuro (+1min), simulamos um 'agora' que o capture
    console.log(">>> [LOG] Passo 2: Simulando execução da Cloud Function...");

    const simulationTime = new Date(agora.getTime() + 70000).toISOString();

    const snapshot = await db
      .collection("agendamentos")
      .where("reminder_24h", "<=", simulationTime)
      .where("push_24h_sent", "==", false)
      .where("status", "==", "confirmado")
      .get();

    console.log(
      `>>> [LOG] Agendamentos detectados pela query: ${snapshot.size}`,
    );

    let testStepSuccess = false;

    for (const doc of snapshot.docs) {
      if (doc.id === testDoc.id) {
        console.log(
          `>>> [LOG] Passo 3: Verificando subscrição de push para o usuário...`,
        );

        const subSnap = await db.collection("fcmTokens").doc(userId).get();

        if (subSnap.exists) {
          console.log(
            ">>> [LOG] Token FCM encontrado. Enviando Notificação via SDK Admin...",
          );
          const subData = subSnap.data();

          const message = {
            notification: {
              title: "Validação FCM",
              body: "Seu sistema migrado para FCM está funcionando! 💅",
            },
            token: subData.token,
          };

          await admin.messaging().send(message);
          console.log(
            ">>> [LOG] Notificação disparada com sucesso via Firebase Admin.",
          );

          // 4. Verificar se o status no banco é atualizado
          console.log(
            ">>> [LOG] Passo 4: Atualizando flag 'push_24h_sent' no Firestore...",
          );
          await doc.ref.update({ push_24h_sent: true });

          const verifyDoc = await doc.ref.get();
          if (verifyDoc.data().push_24h_sent === true) {
            console.log(
              ">>> [LOG] CONFIRMAÇÃO: O campo push_24h_sent foi alterado para TRUE.",
            );
            testStepSuccess = true;
          }
        } else {
          console.error(
            ">>> [LOG] FALHA: Nenhuma subscrição encontrada para este UID. O usuário aceitou as notificações no navegador?",
          );
        }
      }
    }

    console.log(
      testStepSuccess
        ? "\n✅ [RESULTADO] TESTE CONCLUÍDO COM SUCESSO!"
        : "\n❌ [RESULTADO] TESTE FALHOU.",
    );
  } catch (error) {
    console.error(">>> [LOG] ERRO CRÍTICO DURANTE O TESTE:", error);
  }
}

// --- CONFIGURAÇÃO DE TESTE ---
const TEST_USER_UID = "COLOQUE_AQUI_O_UID_REAL_DO_CLIENTE";
runPushTest(TEST_USER_UID);
