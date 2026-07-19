// ======================================================
// ISABELE MARIANA NAILS
// SERVICE WORKER: PWA + CACHE + FIREBASE MESSAGING
// ======================================================

const CACHE_PREFIX = "im-nails";
const CACHE_VERSION = "v1";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./base.css",
  "./index.css",
  "./index.js",
  "./app.js",

  "./assets/favicon.png",
  "./assets/apple-touch-icon.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-192.png",
  "./assets/icon-maskable-512.png",
  "./assets/logo-isabele-mariana.png",
];

// ======================================================
// FIREBASE MESSAGING
// ======================================================

importScripts(
  "https://www.gstatic.com/firebasejs/12.14.0/firebase-app-compat.js",
);

importScripts(
  "https://www.gstatic.com/firebasejs/12.14.0/firebase-messaging-compat.js",
);

let messaging = null;

try {
  firebase.initializeApp({
    apiKey: "AIzaSyC3cBMaCIrF6af3KJpAnrkINErpobu5Ioc",
    authDomain: "isabele-nails-app.firebaseapp.com",
    projectId: "isabele-nails-app",
    storageBucket: "isabele-nails-app.firebasestorage.app",
    messagingSenderId: "311498866336",
    appId: "1:311498866336:web:f063caa25cce715a4813c5",
  });

  messaging = firebase.messaging();
} catch (error) {
  console.warn(
    "[Service Worker] Firebase Messaging não foi inicializado:",
    error,
  );
}

// ======================================================
// INSTALAÇÃO
// ======================================================

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then(async (cache) => {
        const resultados = await Promise.allSettled(
          APP_SHELL.map((url) =>
            cache.add(
              new Request(url, {
                cache: "reload",
              }),
            ),
          ),
        );

        resultados.forEach((resultado, index) => {
          if (resultado.status === "rejected") {
            console.warn(
              "[Service Worker] Não foi possível armazenar:",
              APP_SHELL[index],
            );
          }
        });
      })
      .then(() => self.skipWaiting()),
  );
});

// ======================================================
// ATIVAÇÃO E LIMPEZA DE CACHES ANTIGOS
// ======================================================

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((cacheName) => {
            const pertenceAoApp = cacheName.startsWith(`${CACHE_PREFIX}-`);

            const cacheAtual =
              cacheName === STATIC_CACHE || cacheName === RUNTIME_CACHE;

            if (pertenceAoApp && !cacheAtual) {
              return caches.delete(cacheName);
            }

            return Promise.resolve(false);
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ======================================================
// FUNÇÕES DE CACHE
// ======================================================

async function salvarNoCache(request, response) {
  if (!response || !response.ok) {
    return;
  }

  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(request, response.clone());
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);

    await salvarNoCache(request, response);

    return response;
  } catch (error) {
    const cachedResponse = await caches.match(request);

    if (cachedResponse) {
      return cachedResponse;
    }

    if (request.mode === "navigate") {
      return caches.match("./index.html");
    }

    throw error;
  }
}

async function staleWhileRevalidate(request) {
  const cachedResponse = await caches.match(request);

  const networkPromise = fetch(request)
    .then(async (response) => {
      await salvarNoCache(request, response);
      return response;
    })
    .catch(() => null);

  return cachedResponse || networkPromise || Response.error();
}

// ======================================================
// INTERCEPTAÇÃO DAS REQUISIÇÕES
// ======================================================

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(request.url);

  /*
   * Não armazenamos Firebase, Google Fonts,
   * APIs ou recursos externos.
   */
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  /*
   * Páginas HTML:
   * tenta primeiro a versão da internet.
   */
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));

    return;
  }

  /*
   * CSS, JavaScript, JSON e manifest:
   * prioriza a versão atual da internet.
   */
  const arquivoDinamico =
    requestUrl.pathname.endsWith(".css") ||
    requestUrl.pathname.endsWith(".js") ||
    requestUrl.pathname.endsWith(".json") ||
    requestUrl.pathname.endsWith(".webmanifest");

  if (arquivoDinamico) {
    event.respondWith(networkFirst(request));

    return;
  }

  /*
   * Imagens e ícones:
   * mostra rapidamente o cache e atualiza
   * silenciosamente em segundo plano.
   */
  if (requestUrl.pathname.includes("/assets/")) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

// ======================================================
// NOTIFICAÇÕES EM SEGUNDO PLANO
// ======================================================

if (messaging) {
  messaging.onBackgroundMessage((payload) => {
    /*
     * Quando implementarmos o envio real,
     * vamos priorizar mensagens data-only
     * para evitar notificações duplicadas.
     */
    const title =
      payload?.data?.title ||
      payload?.notification?.title ||
      "Isabele Mariana Nails";

    const body = payload?.data?.body || payload?.notification?.body || "";

    const notificationUrl = payload?.data?.url || "./meu-perfil.html";

    const iconUrl = new URL("./assets/icon-192.png", self.registration.scope)
      .href;

    const badgeUrl = new URL("./assets/favicon.png", self.registration.scope)
      .href;

    const options = {
      body,
      icon: iconUrl,
      badge: badgeUrl,
      tag: payload?.data?.tag || "im-nails-notification",
      renotify: false,
      data: {
        url: notificationUrl,
        ...(payload?.data || {}),
      },
    };

    return self.registration.showNotification(title, options);
  });
}

// ======================================================
// CLIQUE NA NOTIFICAÇÃO
// ======================================================

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const destination = event.notification?.data?.url || "./meu-perfil.html";

  const destinationUrl = new URL(destination, self.registration.scope).href;

  event.waitUntil(
    clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then(async (clientList) => {
        for (const client of clientList) {
          if (client.url === destinationUrl && "focus" in client) {
            return client.focus();
          }
        }

        if (clients.openWindow) {
          return clients.openWindow(destinationUrl);
        }

        return null;
      }),
  );
});
