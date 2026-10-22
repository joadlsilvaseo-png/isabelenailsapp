// ======================================================
// ISABELE MARIANA NAILS
// SERVICE WORKER: PWA + CACHE + FIREBASE MESSAGING
// ======================================================

const CACHE_PREFIX = "im-nails";
const CACHE_VERSION = "v7";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}-runtime-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./login.html",
  "./registro.html",
  "./termos.html",
  "./galeria.html",
  "./principal.html",
  "./admin-servicos.html",
  "./agendamento.html",
  "./categoria.html",

  "./manifest.json",

  "./base.css",
  "./index.css",
  "./login.css",
  "./registro.css",
  "./termos.css",
  "./galeria.css",
  "./principal.css",
  "./admin-servicos.css",
  "./agendamento.css",

  "./index.js",
  "./login.js",
  "./registro.js",
  "./galeria.js",
  "./principal.js",
  "./admin-servicos.js",
  "./agendamento.js",
  "./categoria.js",
  "./manicure.css",
  "./categoriasCatalogo.mjs",
  "./catalogoBusca.mjs",
  "./infra/backend/src/agendamentoRegras.mjs",
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
// WEB PUSH NATIVO - SEM FIREBASE MESSAGING
// ======================================================

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

  /**
   * API Node.js + PostgreSQL:
   * não interceptar requisições /api/.
   * As chamadas devem ir diretamente para a rede,
   * sem utilizar ou atualizar o cache do aplicativo.
   */
  if (
    requestUrl.pathname === "/api" ||
    requestUrl.pathname.startsWith("/api/")
  ) {
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

self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {
      body: event.data ? event.data.text() : "",
    };
  }

  const title = String(payload.title || "Isabele Mariana Nails").slice(0, 100);

  const body = String(
    payload.body || "Você recebeu uma nova notificação.",
  ).slice(0, 220);

  const destination =
    typeof payload.url === "string" &&
    /^\.\/[a-zA-Z0-9/_-]+\.html$/.test(payload.url)
      ? payload.url
      : "./meu-perfil.html";

  const options = {
    body,
    icon: new URL("./assets/icon-192.png", self.registration.scope).href,
    badge: new URL("./assets/favicon.png", self.registration.scope).href,
    tag: String(payload.tag || "isabele-nails"),
    data: {
      url: destination,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

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

