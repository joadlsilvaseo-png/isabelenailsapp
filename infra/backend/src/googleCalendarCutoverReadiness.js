/**
 * Preflight conservador para transicao Calendar (SEM gravacao).
 * Nao concede autorizacao nem troca roteamento de workers.
 */
const FASES = Object.freeze([
  "criacao_pix_pago",
  "criacao_isento",
  "criacao_sem_pix",
  "reagendamento_pix_pago",
  "reagendamento_sem_pix",
  "alteracao_servico",
  "cancelamento",
]);
const SITUACOES_BLOCK = new Set([
  "ambiguo", "sem_correspondencia", "conflito_marcador",
  "conflito_vinculo", "conflito_multiplos_agendamentos",
  "vinculo_ausente", "revisao_recorrencia",
  "candidato_legado", "candidato_marcador_vps",
]);
function erro(codigo) { return Object.assign(new Error("Preflight Calendar: " + codigo), { codigo }); }

export function avaliarPreflightCutover({
  auditoria,
  legadosPendentes,
  operacoesEmAberto,
  credencialConectada = false,
  calendarioCorreto = false,
  aprovacoesPorFluxo = {},
  env = process.env,
} = {}) {
  if (!auditoria || auditoria.somenteLeitura !== true ||
      auditoria.gerouVinculos !== false ||
      auditoria.nenhumaAlteracaoRealizada !== true ||
      auditoria?.resumo?.situacoes == null ||
      typeof auditoria.resumo.situacoes !== "object") throw erro("AUDITORIA_INVALIDA");

  if (!Number.isSafeInteger(legadosPendentes) || legadosPendentes < 0 ||
      !Number.isSafeInteger(operacoesEmAberto) || operacoesEmAberto < 0) {
    throw erro("CONTADORES_INVALIDOS");
  }

  const situacoes = auditoria.resumo.situacoes;
  for (const [nome, valor] of Object.entries(situacoes)) {
    if (typeof nome !== "string" || !Number.isSafeInteger(valor) || valor < 0) {
      throw erro("SITUACOES_INVALIDAS");
    }
  }

  const total = auditoria?.resumo?.agendamentos;
  if (!Number.isSafeInteger(total) || total < 0 ||
      Object.values(situacoes).reduce((a, b) => a + b, 0) !== total) {
    throw erro("CONTAGEM_DIVERGENTE");
  }
  const divergencias = Object.entries(situacoes).filter(([s, n]) =>
    n > 0 && (SITUACOES_BLOCK.has(s) || s !== "vinculo_confirmado"),
  );

  const motivos = [];
  if (!credencialConectada || !calendarioCorreto) motivos.push("OAUTH_OU_CALENDARIO_PENDENTE");
  if (auditoria.fontes?.paginasGoogle == null || !Number.isInteger(auditoria.fontes.paginasGoogle) ||
      auditoria.fontes.paginasGoogle < 1) motivos.push("PAGINACAO_NAO_CONFIRMADA");
  if (total === 0) motivos.push("SEM_AMOSTRA_VALIDADA");
  if (divergencias.length) motivos.push("EVENTOS_NAO_CONCILIADOS");
  if (auditoria.resumo.eventosSemReferencia !== 0) motivos.push("EVENTOS_SEM_REFERENCIA");
  if (legadosPendentes !== 0) motivos.push("APPS_SCRIPT_COM_OPERACOES_PENDENTES");
  if (operacoesEmAberto !== 0) motivos.push("OPERACOES_GOOGLE_EM_ABERTO");

  // As flags nao ligam nada: sem AND de aprovacoes tecnicas + operacionais,
  // o plano e somente "bloqueado" para TODOS os fluxos.
  const fluxos = {};
  for (const nome of FASES) {
    const autorizado = aprovacoesPorFluxo?.[nome] === true;
    const flag = env["GOOGLE_CALENDAR_CUTOVER_" + nome.toUpperCase()] === "true";
    const pronto = motivos.length === 0 &&
      env.GOOGLE_CALENDAR_OAUTH_ENABLED === "true" &&
      env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true" &&
      env.GOOGLE_CALENDAR_CUTOVER_ENABLED === "true" &&
      autorizado && flag;
    fluxos[nome] = { pronto, razoes: pronto ? [] : [
      ...motivos,
      ...(!autorizado ? ["APROVACAO_PENDENTE"] : []),
      ...(!flag ? ["FLAG_FLUXO_DESATIVADA"] : []),
      ...(env.GOOGLE_CALENDAR_CUTOVER_ENABLED !== "true" ||
          env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED !== "true"
        ? ["ESCRITA_DIRETA_DESATIVADA"] : []),
    ] };
  }
  return {
    somenteDiagnostico: true,
    liberaEscritas: false, // Nunca retorna um comando executavel.
    bloqueiosGerais: motivos,
    totalAgendamentos: total,
    fluxos,
  };
}
