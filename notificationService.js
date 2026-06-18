import { db } from "./firebase-config.js";
import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { trackEvent } from "./analytics.js";

// Chave VAPID pública
const VAPID_PUBLIC_KEY =
  "BIsX3O0M9_X_8u3v4N_S5P_R9x2Y7Z6x5W4v3U2t1s0r9Q8P7O6N5M4L3K2J1I0H9G8F7E";

/**
 * Configura Push Notifications para o usuário logado
 */
export async function setupPushNotifications(userId) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    console.warn("Push não suportado neste navegador.");
    return null;
  }

  try {
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      console.warn("Permissão de notificações negada pelo usuário.");
      return null;
    }

    const registration = await navigator.serviceWorker.ready;

    if (!registration) {
      console.error("Service Worker não disponível.");
      return null;
    }

    const applicationServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });

    const subJSON = subscription.toJSON();

    // Salva no Firestore (idempotente por userId)
    await setDoc(doc(db, "pushSubscriptions", userId), {
      endpoint: subJSON.endpoint,
      keys: {
        p256dh: subJSON.keys.p256dh,
        auth: subJSON.keys.auth,
      },
      updatedAt: serverTimestamp(),
    });

    trackEvent("push_subscription_opt_in", {
      user_id: userId,
      timestamp: new Date().toISOString(),
      status: "granted",
    });

    return subscription;
  } catch (error) {
    console.error("Erro ao configurar Push Notifications:", error);
    return null;
  }
}

/**
 * Converte base64 VAPID para Uint8Array (Web Push API padrão)
 */
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}
