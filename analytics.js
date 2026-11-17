/**
 * Configuração Centralizada do Google Analytics 4
 * ID de Medição: G-ZFCQC4FFJS
 */

const MEASUREMENT_ID = "G-ZFCQC4FFJS";

// Inicialização da camada de dados (Data Layer)
window.dataLayer = window.dataLayer || [];
function gtag() {
  window.dataLayer.push(arguments);
}

// Não permitir IDs de serviço/reagendamento ou outros dados de query no GA4.
function urlSemParametros(valor) {
  try {
    const url = new URL(valor);
    return /^https?:$/.test(url.protocol) ? url.origin + url.pathname : "";
  } catch {
    return "";
  }
}
const pageLocation = urlSemParametros(window.location.href);
const pageReferrer = urlSemParametros(document.referrer);
const paginaDeAgendamento = /\/agendamento\.html$/i.test(window.location.pathname);

gtag("js", new Date());
gtag("config", MEASUREMENT_ID, {
  page_location: pageLocation,
  page_referrer: pageReferrer,
  // No agendamento, apenas os eventos controlados; não enviar page_view com IDs.
  ...(paginaDeAgendamento ? { send_page_view: false } : {}),
});

// Carregamento dinâmico do script oficial do Google
const script = document.createElement("script");
script.async = true;
script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
document.head.appendChild(script);

/**
 * Rastreia eventos customizados.
 * @param {string} eventName - Nome do evento (ex: 'login', 'agendamento_concluido')
 * @param {Object} params - Metadados adicionais do evento.
 */
export function trackEvent(eventName, params = {}) {
  gtag("event", eventName, {
    ...params,
    page_location: pageLocation,
    page_referrer: pageReferrer,
  });
}

// Exposição global para scripts que não são módulos (ex: app.js, index.js)
window.trackEvent = trackEvent;
