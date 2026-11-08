/**
 * Politica offline de transicao Calendar.
 *
 * INERTE: nao consulta banco, nao inicia workers, nao modifica eventos.
 * O backend (nunca o frontend) deve fornecer as evidencias ja verificadas.
 * Nao ha fallback para Apps Script depois de iniciar a escrita Google.
 */
const CHAVES = Object.freeze({
  criar: "GOOGLE_CALENDAR_CUTOVER_CRIAR_ENABLED",
  reagendar: "GOOGLE_CALENDAR_CUTOVER_REAGENDAR_ENABLED",
  cancelar: "GOOGLE_CALENDAR_CUTOVER_CANCELAR_ENABLED",
  alterar_servico: "GOOGLE_CALENDAR_CUTOVER_ALTERAR_SERVICO_ENABLED",
});

function decisao(rota, motivo) {
  return Object.freeze({ rota, motivo });
}

export function decidirRotaGoogleCalendar({
  tipo, env = process.env, vinculo = null,
  estadoConciliacao = "nao_verificado", agendamentoNovoAposCorte = false,
  outboxLegadaPresente = null, operacaoPendente = false,
  calendarioId = null,
} = {}) {
  if (!Object.hasOwn(CHAVES, tipo)) return decisao("bloqueado", "TIPO_INVALIDO");
  if (operacaoPendente === true) return decisao("bloqueado", "OPERACAO_EM_ANDAMENTO");
  if (estadoConciliacao === "ambiguo" || estadoConciliacao === "conflito" ||
      estadoConciliacao === "aguardando_confirmacao") {
    return decisao("bloqueado", "CONCILIACAO_INDEFINIDA");
  }
  if (vinculo) {
    if (vinculo.origem !== "vps" && vinculo.origem !== "legado_validado") {
      return decisao("bloqueado", "ORIGEM_DESCONHECIDA");
    }
    if (vinculo.situacao !== "ativo") {
      return decisao("bloqueado", "VINCULO_NAO_ATIVO");
    }
    if (!calendarioId || vinculo.calendar_id !== calendarioId ||
        typeof vinculo.google_event_id !== "string" ||
        vinculo.google_event_id.length < 5) {
      return decisao("bloqueado", "VINCULO_DIVERGENTE");
    }
  }

  const habilitado = env.GOOGLE_CALENDAR_OAUTH_ENABLED === "true" &&
    env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true" &&
    env.GOOGLE_CALENDAR_CUTOVER_ENABLED === "true" &&
    env[CHAVES[tipo]] === "true";

  // Evento ja administrado pela VPS: jamais enviar ao Apps Script, mesmo
  // quando uma flag for desligada por rollback operacional.
  if (vinculo?.origem === "vps" && !habilitado) {
    return decisao("bloqueado", "GOOGLE_EXISTENTE_PAUSADO");
  }

  if (!habilitado) return decisao("apps_script", "CORTE_NAO_HABILITADO");

  if (tipo === "criar") {
    if (vinculo) return decisao("bloqueado", "EVENTO_JA_VINCULADO");
    if (agendamentoNovoAposCorte !== true ||
        estadoConciliacao !== "sem_evento_confirmado" ||
        outboxLegadaPresente !== false) {
      return decisao("bloqueado", "CRIACAO_SEM_EVIDENCIA");
    }
    return decisao("google_direto", "NOVO_AGENDAMENTO_ELEGIVEL");
  }

  if (!vinculo || vinculo.origem !== "vps") {
    return decisao("bloqueado", "LEGADO_EXIGE_RECONCILIACAO");
  }
  if (estadoConciliacao !== "vinculo_confirmado") {
    return decisao("bloqueado", "VINCULO_NAO_VERIFICADO");
  }
  return decisao("google_direto", "VINCULO_VPS_VERIFICADO");
}

export function flagsGoogleCalendarCutover(env = process.env) {
  return Object.freeze({
    global: env.GOOGLE_CALENDAR_CUTOVER_ENABLED === "true" &&
      env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true" &&
      env.GOOGLE_CALENDAR_OAUTH_ENABLED === "true",
    criar: env.GOOGLE_CALENDAR_CUTOVER_CRIAR_ENABLED === "true",
    reagendar: env.GOOGLE_CALENDAR_CUTOVER_REAGENDAR_ENABLED === "true",
    cancelar: env.GOOGLE_CALENDAR_CUTOVER_CANCELAR_ENABLED === "true",
    alterarServico: env.GOOGLE_CALENDAR_CUTOVER_ALTERAR_SERVICO_ENABLED === "true",
  });
}
