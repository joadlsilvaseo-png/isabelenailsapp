import test from "node:test";
import assert from "node:assert/strict";
import { avaliarPreflightCutover } from "../src/googleCalendarCutoverReadiness.js";

const SITUACOES = ["vinculo_confirmado","candidato_legado","ambiguo","conflito_marcador"];
function auditoria(situacoes = { vinculo_confirmado: 2 }, outros = {}) {
  return {
    somenteLeitura: true,
    gerouVinculos: false,
    nenhumaAlteracaoRealizada: true,
    fontes: { paginasGoogle: 2 },
    resumo: { agendamentos: Object.values(situacoes).reduce((a,b)=>a+b,0),
      eventosSemReferencia: 0, situacoes },
    ...outros,
  };
}
const flags = {
  GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_CRIACAO_PIX_PAGO: "true",
};
const op = (params={}) => avaliarPreflightCutover({
  auditoria: auditoria(),
  legadosPendentes: 0, operacoesEmAberto: 0,
  credencialConectada: true, calendarioCorreto: true,
  aprovacoesPorFluxo: { criacao_pix_pago: true },
  env: flags, ...params,
});

test("diagnostico nao executa operacoes, mesmo quando preflight limpo", () => {
  const res = op();
  assert.equal(res.somenteDiagnostico, true);
  assert.equal(res.liberaEscritas, false);
  assert.equal(res.fluxos.criacao_pix_pago.pronto, true);
  assert.equal(res.fluxos.cancelamento.pronto, false);
  assert.equal(res.bloqueiosGerais.length, 0);
});

test("cada fluxo exige aprovacao e flag independente", () => {
  const x = op({ aprovacoesPorFluxo: {} });
  assert.equal(Object.values(x.fluxos).every(v => !v.pronto), true);
  assert.ok(x.fluxos.criacao_pix_pago.razoes.includes("APROVACAO_PENDENTE"));
  const y = op({ env: { ...flags, GOOGLE_CALENDAR_CUTOVER_CRIACAO_PIX_PAGO: "false" } });
  assert.equal(y.fluxos.criacao_pix_pago.pronto, false);
  assert.ok(y.fluxos.criacao_pix_pago.razoes.includes("FLAG_FLUXO_DESATIVADA"));
});

test("flags globais desligadas nunca passam", () => {
  for (const nome of ["GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED", "GOOGLE_CALENDAR_CUTOVER_ENABLED"]) {
    const cfg = { ...flags }; delete cfg[nome];
    const x = op({ env: cfg });
    assert.equal(x.fluxos.criacao_pix_pago.pronto, false);
  }
  const semOAuth = op({ env: { ...flags, GOOGLE_CALENDAR_OAUTH_ENABLED: "false" } });
  assert.equal(semOAuth.fluxos.criacao_pix_pago.pronto, false);
});

test("qualquer candidato, ambiguidade ou conflito interrompe cutover", () => {
  for (const status of SITUACOES.slice(1)) {
    const x = op({ auditoria: auditoria({ vinculo_confirmado: 1, [status]: 1 }) });
    assert.equal(x.fluxos.criacao_pix_pago.pronto, false, status);
    assert.ok(x.bloqueiosGerais.includes("EVENTOS_NAO_CONCILIADOS"));
  }
});

test("sem referencias Google, sem contas ou paginacao incompleta bloqueia", () => {
  const semEvento = op({ auditoria: auditoria({ vinculo_confirmado: 2 }, {
    resumo: { agendamentos: 2, eventosSemReferencia: 3, situacoes: { vinculo_confirmado: 2 } },
  }) });
  assert.ok(semEvento.bloqueiosGerais.includes("EVENTOS_SEM_REFERENCIA"));
  const vazio = op({ auditoria: auditoria({}) });
  assert.ok(vazio.bloqueiosGerais.includes("SEM_AMOSTRA_VALIDADA"));
  const paginas = op({ auditoria: auditoria(undefined, { fontes: { paginasGoogle: null } }) });
  assert.ok(paginas.bloqueiosGerais.includes("PAGINACAO_NAO_CONFIRMADA"));
});

test("pendencias Apps Script ou nova fila bloqueiam todos os fluxos", () => {
  const x = op({ legadosPendentes: 1 });
  assert.ok(x.bloqueiosGerais.includes("APPS_SCRIPT_COM_OPERACOES_PENDENTES"));
  assert.equal(Object.values(x.fluxos).some(f => f.pronto), false);
  const y = op({ operacoesEmAberto: 2 });
  assert.ok(y.bloqueiosGerais.includes("OPERACOES_GOOGLE_EM_ABERTO"));
  assert.equal(Object.values(y.fluxos).some(f => f.pronto), false);
});

test("nao aceitar auditoria falsa, contagem divergente ou contadores incompletos", () => {
  assert.throws(() => op({ auditoria: {} }), { codigo: "AUDITORIA_INVALIDA" });
  assert.throws(() => op({ auditoria: auditoria({ vinculo_confirmado: 1 }, {
    resumo: { agendamentos: 12, eventosSemReferencia: 0, situacoes: { vinculo_confirmado: 1 } },
  }) }), { codigo: "CONTAGEM_DIVERGENTE" });
  assert.throws(() => op({ legadosPendentes: -1 }), { codigo: "CONTADORES_INVALIDOS" });
  assert.throws(() => op({ operacoesEmAberto: undefined }), { codigo: "CONTADORES_INVALIDOS" });
});

test("identidade Google errada bloqueia mesmo com demais condicoes satisfeitas", () => {
  for(const campo of ["credencialConectada","calendarioCorreto"]) {
    const x = op({ [campo]: false });
    assert.ok(x.bloqueiosGerais.includes("OAUTH_OU_CALENDARIO_PENDENTE"));
    assert.equal(x.fluxos.criacao_pix_pago.pronto, false);
  }
});
