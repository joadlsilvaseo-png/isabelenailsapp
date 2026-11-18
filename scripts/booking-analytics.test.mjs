import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  criarRastreamentoAgendamento,
  categoriaAgendamentoSegura,
  faixaHorarioAgendamento,
  vincularRastreamentoCheckout,
  emitirMarcoCheckout,
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
  assert.match(js, /bookingAnalytics\.mjs\?v=1\.1\.0/);
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
  assert.match(html, /agendamento\.js\?v=2\.12\.1/);
  assert.match(js, /consultarDisponibilidadePix\(auth, String\(dataIso\)\.trim\(\), idConsultaPix\)/);
  assert.match(js, /reagendarAgendamentoApi\(auth, \{/);
  assert.match(js, /definirBloqueioTurnos\(horariosContainer, true, alternarIndisponiveis\)/);
});

test("2B: distingue clique, cotação, QR e confirmação, sem marcar pagamento prematuro", () => {
  const { eventos, monitor } = coletor();
  monitor.permitir(true);
  monitor.marcoCheckout("submit");
  monitor.marcoCheckout("quote");
  monitor.marcoCheckout("qr", "reserva-confidencial-A");
  assert.deepEqual(eventos.map((e) => e.nome), [
    "booking_submit_clicked", "booking_quote_viewed", "booking_pix_qr_shown",
  ]);
  assert.equal(eventos.every((e) => e.nome !== "booking_pix_confirmed_ui"), true);
  monitor.marcoCheckout("pix_confirmed", "reserva-confidencial-A");
  assert.equal(eventos.at(-1).nome, "booking_pix_confirmed_ui");
  assert.equal(eventos.at(-1).dados.payment_path, "pix");
});

test("2B: confirmação PIX, QR e isenção idempotentes por operação, sem vazar referências", () => {
  const { eventos, monitor } = coletor();
  monitor.permitir(true);
  monitor.marcoCheckout("qr", "ref-privada-a");
  monitor.marcoCheckout("qr", "ref-privada-a");
  monitor.marcoCheckout("qr", "ref-privada-b");
  monitor.marcoCheckout("pix_confirmed", "ref-privada-a");
  monitor.marcoCheckout("pix_confirmed", "ref-privada-a");
  monitor.marcoCheckout("exempt_confirmed", "doc-secreto-x");
  monitor.marcoCheckout("exempt_confirmed", "doc-secreto-x");
  assert.deepEqual(eventos.map((e) => e.nome), [
    "booking_pix_qr_shown", "booking_pix_qr_shown",
    "booking_pix_confirmed_ui", "booking_exempt_confirmed_ui",
  ]);
  assert.equal(eventos.at(-1).dados.payment_path, "exempt");
  assert.doesNotMatch(JSON.stringify(eventos), /ref-privada|doc-secreto|agendamentoId|clienteId/);
});

test("2B: fluxo novo não contabiliza reagendamento e vice-versa", () => {
  const novo = coletor();
  novo.monitor.permitir(true);
  novo.monitor.marcoCheckout("reschedule_completed", "id-privado");
  assert.deepEqual(novo.eventos, []);

  const antigo = coletor({ flowType: "reschedule" });
  antigo.monitor.permitir(true);
  antigo.monitor.marcoCheckout("submit");
  antigo.monitor.marcoCheckout("quote");
  antigo.monitor.marcoCheckout("qr", "ref-a");
  antigo.monitor.marcoCheckout("pix_confirmed", "ref-a");
  antigo.monitor.marcoCheckout("exempt_confirmed", "ref-b");
  antigo.monitor.marcoCheckout("reschedule_completed", "id-privado");
  antigo.monitor.marcoCheckout("reschedule_completed", "id-privado");
  assert.deepEqual(antigo.eventos.map((e) => e.nome), [
    "booking_submit_clicked", "booking_reschedule_completed_ui",
  ]);
});

test("2B: marcos só são enviados após autorização; admin não polui checkout", () => {
  const { eventos, monitor } = coletor();
  vincularRastreamentoCheckout(monitor);
  try {
    emitirMarcoCheckout("submit");
    emitirMarcoCheckout("quote");
    emitirMarcoCheckout("qr", "id-local");
    assert.equal(eventos.length, 0);
    monitor.permitir(false);
    emitirMarcoCheckout("pix_confirmed", "id-local");
    assert.equal(eventos.length, 0);
  } finally {
    vincularRastreamentoCheckout(null);
  }
});

test("2B: módulos compartilham instância autorizada sem segunda tag GA4", () => {
  const { eventos, monitor } = coletor();
  vincularRastreamentoCheckout(monitor);
  try {
    monitor.permitir(true);
    emitirMarcoCheckout("quote");
    emitirMarcoCheckout("pix_confirmed", "referencia-privada");
    emitirMarcoCheckout("pix_confirmed", "referencia-privada");
    emitirMarcoCheckout("desconhecido", "abc");
    assert.deepEqual(eventos.map((e) => e.nome), [
      "booking_quote_viewed", "booking_pix_confirmed_ui",
    ]);
  } finally {
    vincularRastreamentoCheckout(null);
  }
  emitirMarcoCheckout("submit");
  assert.equal(eventos.length, 2);
});

test("2B: keys vazias não criam sucesso nem eventos de QR", () => {
  const { eventos, monitor } = coletor();
  monitor.permitir(true);
  monitor.marcoCheckout("qr", "");
  monitor.marcoCheckout("pix_confirmed");
  monitor.marcoCheckout("exempt_confirmed", null);
  monitor.marcoCheckout("reschedule_completed", "id-qualquer");
  assert.deepEqual(eventos, []);
});

test("2B: integração com checkout mede os marcos após validação das respostas", async () => {
  const pix = await ler("pixCheckout.js");
  const agenda = await ler("agendamento.js");
  const html = await ler("agendamento.html");
  assert.match(pix, /const dados = selecionarDados\(\);\s*\/\/ Apenas clique válido[\s\S]*?if \(cliqueConfirmar\) emitirMarcoCheckout\("submit"\)/);
  assert.match(pix, /const cotacao = await postApi\("\/pix\/cotacao"/);
  assert.match(pix, /apresentarCotacao\(cotacao, dados\)/);
  assert.match(pix, /emitirMarcoCheckout\("quote"\)/);
  assert.match(pix, /caixaPix\.hidden = false;[\s\S]{0,220}emitirMarcoCheckout\("qr", reservaAtual\?\.reservaId\)/);
  assert.match(pix, /if \(retorno\.agendamentoConfirmado === true\) \{\s*concluirAgendamento\(\)/);
  assert.match(pix, /function concluirAgendamento\(\) \{[\s\S]*?emitirMarcoCheckout\("pix_confirmed", reservaAtual\?\.reservaId\)/);
  assert.match(pix, /const agendamento = await postApi\("\/agendamentos\/sem-pix"/);
  assert.match(pix, /emitirMarcoCheckout\("exempt_confirmed", agendamento\.agendamentoId\)/);
  assert.match(agenda, /if \(reagendarId\) rastreamento\.marcoCheckout\("submit"\)/);
  assert.match(agenda, /if \(pixConfirmadoNoBackend\) rastreamento\.marcoCheckout\("reschedule_completed", reagendarId\)/);
  assert.match(agenda, /if \(resultadoReagendamento\.sincronizacaoCalendar !== "confirmada" &&[\s\S]*?rastreamento\.marcoCheckout\("reschedule_completed", reagendarId\)/);
  assert.match(html, /agendamento\.js\?v=2\.12\.1/);
  assert.match(html, /pixCheckout\.js\?v=1\.0\.3/);
  assert.match(agenda, /bookingAnalytics\.mjs\?v=1\.1\.0/);
  assert.match(pix, /bookingAnalytics\.mjs\?v=1\.1\.0/);
});

test("2B: exceção de Analytics não modifica caminho operacional", () => {
  const monitor = criarRastreamentoAgendamento({
    send() { throw new Error("GA4 bloqueado"); },
  });
  monitor.permitir(true);
  vincularRastreamentoCheckout(monitor);
  try {
    assert.doesNotThrow(() => {
      emitirMarcoCheckout("submit");
      emitirMarcoCheckout("quote");
      emitirMarcoCheckout("qr", "reserva");
      emitirMarcoCheckout("pix_confirmed", "reserva");
      emitirMarcoCheckout("exempt_confirmed", "doc");
    });
  } finally {
    vincularRastreamentoCheckout(null);
  }
});
