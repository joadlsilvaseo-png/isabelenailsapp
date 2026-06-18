import { app, db } from "./firebase-config.js";
import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import {
  getMessaging,
  getToken,
  onMessage,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging.js";
import { trackEvent } from "./analytics.js";

// Inicializa o Firebase Messaging
const messaging = getMessaging(app);

/**
 * Configura Firebase Cloud Messaging para o usuário logado
 */
export async function setupPushNotifications(userId) {
  if (!("serviceWorker" in navigator)) {
    console.warn("Service Worker não suportado neste navegador.");
    return null;
  }

  try {
    // 1. Solicitar permissão
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      console.warn("Permissão de notificações negada pelo usuário.");
      return null;
    }

    // 2. Obter o Service Worker pronto
    const registration = await navigator.serviceWorker.ready;

    // 3. Obter Token FCM
    const token = await getToken(messaging, {
      serviceWorkerRegistration: registration,
    });

    if (!token) {
      console.warn("Nenhum token FCM gerado.");
      return null;
    }

    // 4. Salva no Firestore na nova coleção fcmTokens
    await setDoc(doc(db, "fcmTokens", userId), {
      token: token,
      updatedAt: serverTimestamp(),
    });

    // 5. Listener para mensagens em foreground
    onMessage(messaging, (payload) => {
      console.log("Mensagem recebida em foreground: ", payload);
      // Exibe um alerta simples ou toast customizado
      alert(`${payload.notification.title}: ${payload.notification.body}`);
    });

    trackEvent("push_subscription_opt_in", {
      user_id: userId,
      timestamp: new Date().toISOString(),
      status: "granted",
    });

    return token;
  } catch (error) {
    console.error("Erro ao configurar FCM:", error);
    return null;
  }
}
