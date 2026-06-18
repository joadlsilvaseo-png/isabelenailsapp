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

gtag("js", new Date());
gtag("config", MEASUREMENT_ID);

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
  gtag("event", eventName, params);
}

// Exposição global para scripts que não são módulos (ex: app.js, index.js)
window.trackEvent = trackEvent;
