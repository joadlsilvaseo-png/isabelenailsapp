// ===============================
// FCM SERVICE WORKER (PRODUÇÃO)
// ===============================

importScripts(
  "https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js",
);
importScripts(
  "https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js",
);

// -------------------------------
// Firebase Init
// -------------------------------
firebase.initializeApp({
  apiKey: "SUA_API_KEY",
  authDomain: "SEU_AUTH_DOMAIN",
  projectId: "SEU_PROJECT_ID",
  storageBucket: "SEU_STORAGE_BUCKET",
  messagingSenderId: "311498866336",
  appId: "SEU_APP_ID",
});

const messaging = firebase.messaging();

// -------------------------------
// BACKGROUND NOTIFICATION (FCM)
// -------------------------------
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || "Notificação";
  const options = {
    body: payload?.notification?.body || "",
    icon: "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    data: payload?.data || {},
  };

  self.registration.showNotification(title, options);
});

// -------------------------------
// NOTIFICATION CLICK
// -------------------------------
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification?.data?.url || "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === url && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      }),
  );
});

// -------------------------------
// OPTIONAL: INSTALL / ACTIVATE CLEANUP
// -------------------------------
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
