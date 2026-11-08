import test from "node:test";
import assert from "node:assert/strict";
import { decidirRotaGoogleCalendar, flagsGoogleCalendarCutover } from "../src/googleCalendarCutoverPolicy.js";

const CAL = "isabelemarianavieiralima@gmail.com";
const ENV = {
  GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_CRIAR_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_REAGENDAR_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_CANCELAR_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ALTERAR_SERVICO_ENABLED: "true",
};
const vps = {
  origem: "vps", situacao: "ativo", calendar_id: CAL, google_event_id: "imn12345",
};
const legado = { ...vps, origem: "legado_validado" };
const decidir = (extras = {}) => decidirRotaGoogleCalendar({
  tipo: "reagendar", env: ENV, vinculo: vps, calendarioId: CAL,
  estadoConciliacao: "vinculo_confirmado", ...extras,
});

test("por omissao, nenhum cutover fica habilitado", () => {
  const env = { GOOGLE_CALENDAR_OAUTH_ENABLED: "true" };
  assert.equal(flagsGoogleCalendarCutover(env).global, false);
  assert.deepEqual(decidirRotaGoogleCalendar({
    tipo: "criar", env, agendamentoNovoAposCorte: true,
    estadoConciliacao: "sem_evento_confirmado", outboxLegadaPresente: false,
  }), { rota: "apps_script", motivo: "CORTE_NAO_HABILITADO" });
});

test("vinculo gerenciado pela VPS NUNCA volta automaticamente ao Apps Script", () => {
  for (const campo of [
    "GOOGLE_CALENDAR_CUTOVER_ENABLED",
    "GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_REAGENDAR_ENABLED",
  ]) {
    const env = { ...ENV, [campo]: "false" };
    assert.deepEqual(decidir({ env }), {
      rota: "bloqueado", motivo: "GOOGLE_EXISTENTE_PAUSADO",
    });
  }
});

test("reagendar, cancelar e alterar servico so podem usar evento VPS verificado", () => {
  for (const tipo of ["reagendar", "cancelar", "alterar_servico"]) {
    assert.deepEqual(decidir({ tipo }), {
      rota: "google_direto", motivo: "VINCULO_VPS_VERIFICADO",
    });
    assert.deepEqual(decidir({ tipo, vinculo: legado }), {
      rota: "bloqueado", motivo: "LEGADO_EXIGE_RECONCILIACAO",
    });
    assert.deepEqual(decidir({ tipo, vinculo: null }), {
      rota: "bloqueado", motivo: "LEGADO_EXIGE_RECONCILIACAO",
    });
  }
});

test("criacao exige agendamento NOVO e ausencia comprovada de outbox antiga", () => {
  const base = { tipo: "criar", vinculo: null, estadoConciliacao: "sem_evento_confirmado",
    outboxLegadaPresente: false, agendamentoNovoAposCorte: true };
  assert.equal(decidir(base).rota, "google_direto");
  for (const extra of [
    { agendamentoNovoAposCorte: false },
    { outboxLegadaPresente: true },
    { outboxLegadaPresente: null },
    { estadoConciliacao: "nao_verificado" },
    { vinculo: vps },
  ]) assert.equal(decidir({ ...base, ...extra }).rota, "bloqueado");
});

test("ambiguidade e resultado incerto nao causam fallback", () => {
  for (const estadoConciliacao of ["ambiguo", "conflito", "aguardando_confirmacao"]) {
    assert.deepEqual(decidir({ estadoConciliacao }),
      { rota: "bloqueado", motivo: "CONCILIACAO_INDEFINIDA" });
  }
  assert.deepEqual(decidir({ operacaoPendente: true }), {
    rota: "bloqueado", motivo: "OPERACAO_EM_ANDAMENTO",
  });
});

test("vinculo cancelado, calendario divergente ou incompleto bloqueiam", () => {
  for (const vinculo of [
    { ...vps, situacao: "cancelado" },
    { ...vps, calendar_id: "outro@example.com" },
    { ...vps, google_event_id: "" },
  ]) assert.equal(decidir({ vinculo }).rota, "bloqueado");
});

test("legado continua no Apps Script quando cutover esta desabilitado", () => {
  assert.deepEqual(decidir({ env: { ...ENV, GOOGLE_CALENDAR_CUTOVER_ENABLED: "false" },
    vinculo: legado }), { rota: "apps_script", motivo: "CORTE_NAO_HABILITADO" });
});

test("tipo desconhecido nao tem permissao nem fallback", () => {
  assert.deepEqual(decidir({ tipo: "outro" }),
    { rota: "bloqueado", motivo: "TIPO_INVALIDO" });
});
