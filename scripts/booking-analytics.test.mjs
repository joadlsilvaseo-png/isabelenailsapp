import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  criarRastreamentoAgendamento,
  categoriaAgendamentoSegura,
  faixaHorarioAgendamento,
} from "../bookingAnalytics.mjs";

const ler = (nome) => readFile(new URL("../" + nome, import.meta.url), "utf8");
const coletor = (parametros = {}) => {
  const eventos = [];
  const monitor = criarRastreamentoAgendamento({
    flowType: "new",
    serviceCategory: "Unhas em Gel",
    send: (nome, dados) => eventos.push({ nome, dados }),
    ...parametros,
  });
  return { eventos, monitor };
};

test("telemetria é inerte até a permissão explícita de cliente", () => {
  const { eventos, monitor } = coletor();
  monitor.iniciar();
  monitor.dataSelecionada();
  monitor.sugestoesExibidas();
  assert.deepEqual(eventos, []);
  monitor.permitir(true);
  assert.deepEqual(eventos.map((e) => e.nome), [
    "booking_flow_started", "booking_date_selected", "booking_suggestions_displayed",
  ]);
  assert.deepEqual(eventos[0].dados, {
    flow_type: "new", actor_role: "client",
    service_category: "unhas-em-gel", analytics_schema_version: 1,
  });
});

test("conta administrativa, anônima ou sem permissão não envia nem eventos posteriores", () => {
  const { eventos, monitor } = coletor();
  monitor.iniciar();
  monitor.horarioSelecionado("suggestion", "14:00");
  monitor.permitir(false);
  monitor.permitir(true);
  monitor.gradeAberta();
  assert.deepEqual(eventos, []);
});

test("fluxo e sugestões exibidas não duplicam em re-renderização", () => {
  const { eventos, monitor } = coletor({ flowType: "reschedule" });
  monitor.permitir(true);
  monitor.iniciar();
  monitor.iniciar();
  monitor.sugestoesExibidas();
  monitor.sugestoesExibidas();
  assert.deepEqual(eventos.map((e) => e.nome), [
    "booking_flow_started", "booking_suggestions_displayed",
  ]);
  assert.ok(eventos.every((e) => e.dados.flow_type === "reschedule"));
});

test("seleção por sugestão usa origem correta e não expõe horário exato", () => {
  const { eventos, monitor } = coletor();
  monitor.permitir(true);
  monitor.sugestaoSelecionada();
  monitor.horarioSelecionado("suggestion", "15:30");
  monitor.horarioSelecionado("full_list", "09:00");
  assert.deepEqual(eventos.map((e) => e.nome), [
    "booking_suggestion_selected", "booking_time_selected", "booking_time_selected",
  ]);
  assert.equal(eventos[1].dados.selection_source, "suggestion");
  assert.equal(eventos[1].dados.time_bucket, "afternoon");
  assert.equal(eventos[2].dados.selection_source, "full_list");
  assert.equal(eventos[2].dados.time_bucket, "morning");
  assert.doesNotMatch(JSON.stringify(eventos), /15:30|09:00|nomeCliente|clienteId|reagendar=/);
});

test("não aceita horários inválidos nem origens inventadas", () => {
  const { eventos, monitor } = coletor();
  monitor.permitir(true);
  monitor.horarioSelecionado("suggestion", "14:90");
  monitor.horarioSelecionado("admin", "14:00");
  monitor.horarioSelecionado("full_list", "18:00");
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].dados.time_bucket, "evening");
});

test("categoria está em allowlist curta; nenhum nome livre vira dimensão", () => {
  assert.equal(categoriaAgendamentoSegura("Unhas em Gel"), "unhas-em-gel");
  assert.equal(categoriaAgendamentoSegura("Manicure"), "manicure");
  assert.equal(categoriaAgendamentoSegura("Cliente Fulana Serviço Especial"), "unknown");
  assert.equal(faixaHorarioAgendamento("17:59"), "afternoon");
  assert.equal(faixaHorarioAgendamento("18:00"), "evening");
  assert.equal(faixaHorarioAgendamento("texto"), null);
});

test("falha em Analytics não impede registro de outras ações", () => {
  const monitor = criarRastreamentoAgendamento({
    send() { throw Error("serviço externo indisponível"); },
  });
  assert.doesNotThrow(() => {
    monitor.iniciar();
    monitor.permitir(true);
    monitor.dataSelecionada();
    monitor.gradeAberta();
  });
});

test("ligação de UI usa validação de sugestão e clique manual confiável", async () => {
  const js = await ler("agendamento.js");
  assert.match(js, /if \(selecionado\) \{\s*rastreamento\?\.sugestaoSelecionada\(\)/);
  assert.match(js, /if \(event\.isTrusted\) rastreamento\.horarioSelecionado\("full_list"/);
  assert.match(js, /rastreamento\?\.sugestoesExibidas\(\)/);
  assert.match(js, /if \(origemAdmin\) \{\s*rastreamento\.permitir\(false\)/);
  assert.match(js, /perfil\.data\(\)\?\.ativo === true/);
  assert.match(js, /bookingAnalytics\.mjs\?v=1\.0\.0/);
});

test("GA4 recebe apenas pathname e não carrega page_view automática de agendamento", async () => {
  const analytics = await ler("analytics.js");
  assert.match(analytics, /url\.origin \+ url\.pathname/);
  assert.match(analytics, /page_location: pageLocation/);
  assert.match(analytics, /page_referrer: pageReferrer/);
  assert.match(analytics, /paginaDeAgendamento \? \{ send_page_view: false \}/);
  assert.doesNotMatch(analytics, /user_id|firebase_uid|document\.cookie/);
});

test("o caminho de agendamento não altera checkout PIX nem o backend", async () => {
  const html = await ler("agendamento.html");
  const js = await ler("agendamento.js");
  assert.match(html, /agendamento\.js\?v=2\.10\.0/);
  assert.match(js, /consultarDisponibilidadePix\(auth, String\(dataIso\)\.trim\(\), idConsultaPix\)/);
  assert.match(js, /reagendarAgendamentoApi\(auth, \{/);
  assert.match(js, /definirBloqueioTurnos\(horariosContainer, true, alternarIndisponiveis\)/);
});
