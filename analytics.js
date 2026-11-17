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
const paginaDeAgendamento = /\/agendamento\.html$/i.test(window.location.pathname);
const pageLocation = urlSemParametros(window.location.href);
const pageReferrer = urlSemParametros(document.referrer);
// Outras páginas mantêm sua atribuição de campanhas; referrer vindo de
// agendamento nunca transporta IDs para page_views subsequentes.
const referenciadoAgendamento = /\/agendamento\.html$/i.test(
  (() => {
    try { return new URL(document.referrer).pathname; } catch { return ""; }
  })(),
);

gtag("js", new Date());
gtag("config", MEASUREMENT_ID, {
  // Preserva UTM/campanhas das telas existentes. Só filtra as rotas sensíveis.
  ...(paginaDeAgendamento ? { page_location: pageLocation } : {}),
  ...(paginaDeAgendamento || referenciadoAgendamento ? { page_referrer: pageReferrer } : {}),
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
  // Sobrescreve metadados sensíveis somente quando a URL de agendamento
  // está envolvida. Não altera a atribuição do restante do site.
  const contextoSeguro = {
    ...(paginaDeAgendamento ? { page_location: pageLocation } : {}),
    ...(paginaDeAgendamento || referenciadoAgendamento ? { page_referrer: pageReferrer } : {}),
  };
  gtag("event", eventName, { ...params, ...contextoSeguro });
}

// Exposição global para scripts que não são módulos (ex: app.js, index.js)
window.trackEvent = trackEvent;
