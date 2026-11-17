/**
 * Análise Web — Fases 2A/2B. Contrato de eventos da jornada de agendamento.
 * Sem dependências de navegador/Firebase; envio depende de autorização da cliente.
 * Somente dimensões enumeradas: nenhuma informação pessoal ou ID de reserva.
 */
const EVENTOS = new Set([
  "booking_flow_started",
  "booking_date_selected",
  "booking_suggestions_displayed",
  "booking_suggestion_selected",
  "booking_all_times_opened",
  "booking_time_selected",
  "booking_submit_clicked",
  "booking_quote_viewed",
  "booking_pix_qr_shown",
  "booking_pix_confirmed_ui",
  "booking_exempt_confirmed_ui",
  "booking_reschedule_completed_ui",
]);

// Chaves operacionais usadas SOMENTE para deduplicar na memoria; jamais no GA4.
const MARCOS = Object.freeze({
  submit: { nome: "booking_submit_clicked" },
  quote: { nome: "booking_quote_viewed", payment_path: "pix", fluxo: "new" },
  qr: { nome: "booking_pix_qr_shown", payment_path: "pix", fluxo: "new", unico: true },
  pix_confirmed: { nome: "booking_pix_confirmed_ui", payment_path: "pix", fluxo: "new", unico: true },
  exempt_confirmed: { nome: "booking_exempt_confirmed_ui", payment_path: "exempt", fluxo: "new", unico: true },
  reschedule_completed: { nome: "booking_reschedule_completed_ui", fluxo: "reschedule", unico: true },
});

// A agenda e o checkout são módulos independentes da mesma página.
// O checkout só publica marcos através do rastreamento autorizado pela agenda.
let rastreamentoCompartilhado = null;

export function vincularRastreamentoCheckout(rastreamento) {
  rastreamentoCompartilhado = typeof rastreamento?.marcoCheckout === "function"
    ? rastreamento : null;
}

export function emitirMarcoCheckout(etapa, chave = null) {
  try { rastreamentoCompartilhado?.marcoCheckout(etapa, chave); } catch {
    // Telemetria opcional: nenhuma exceção pode interromper o PIX.
  }
}
const CATEGORIAS = new Map([
  ["manicure", "manicure"],
  ["pedicure", "pedicure"],
  ["unhas em gel", "unhas-em-gel"],
  ["unhas-em-gel", "unhas-em-gel"],
]);

export function categoriaAgendamentoSegura(valor) {
  const nome = String(valor ?? "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
  return CATEGORIAS.get(nome) || "unknown";
}

export function faixaHorarioAgendamento(valor) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(valor))) return null;
  const hora = Number(String(valor).slice(0, 2));
  return hora < 12 ? "morning" : hora < 18 ? "afternoon" : "evening";
}

/**
 * Registra somente o funil de clientes. Antes de confirmar a permissão,
 * mantém no máximo 32 eventos em memória, sem ativar o GA4.
 * Uma recusa descarta a fila e impede qualquer envio.
 */
export function criarRastreamentoAgendamento({ flowType, serviceCategory, send } = {}) {
  const contexto = Object.freeze({
    flow_type: flowType === "reschedule" ? "reschedule" : "new",
    actor_role: "client",
    service_category: categoriaAgendamentoSegura(serviceCategory),
    analytics_schema_version: 1,
  });
  let permitido = null;
  let iniciou = false;
  let exibiuSugestoes = false;
  const marcosUnicos = new Set();
  const pendentes = [];

  function entregar(evento) {
    try {
      send?.(evento.nome, evento.parametros);
    } catch {
      // Analytics nunca pode interromper a agenda ou o PIX.
    }
  }
  function emitir(nome, extras = {}) {
    if (!EVENTOS.has(nome) || permitido === false) return;
    const evento = { nome, parametros: { ...contexto, ...extras } };
    if (permitido === true) {
      entregar(evento);
    } else if (pendentes.length < 32) {
      pendentes.push(evento);
    }
  }

  return {
    permitir(autorizado) {
      if (permitido !== null) return;
      permitido = autorizado === true;
      if (permitido) pendentes.forEach(entregar);
      pendentes.length = 0;
    },
    iniciar() {
      if (iniciou) return;
      iniciou = true;
      emitir("booking_flow_started");
    },
    dataSelecionada() {
      emitir("booking_date_selected");
    },
    sugestoesExibidas() {
      if (exibiuSugestoes) return;
      exibiuSugestoes = true;
      emitir("booking_suggestions_displayed");
    },
    sugestaoSelecionada() {
      emitir("booking_suggestion_selected");
    },
    gradeAberta() {
      emitir("booking_all_times_opened");
    },
    marcoCheckout(etapa, chave = null) {
      const marco = Object.hasOwn(MARCOS, etapa) ? MARCOS[etapa] : null;
      if (!marco || (marco.fluxo && marco.fluxo !== contexto.flow_type)) return;
      if (marco.unico) {
        const local = typeof chave === "string" ? chave.trim() : "";
        if (!local || marcosUnicos.has(etapa + ":" + local)) return;
        marcosUnicos.add(etapa + ":" + local);
      }
      emitir(marco.nome, marco.payment_path ? { payment_path: marco.payment_path } : {});
    },
    horarioSelecionado(origem, horario) {
      if (origem !== "suggestion" && origem !== "full_list") return;
      const timeBucket = faixaHorarioAgendamento(horario);
      if (!timeBucket) return;
      emitir("booking_time_selected", {
        selection_source: origem,
        time_bucket: timeBucket,
      });
    },
  };
}
