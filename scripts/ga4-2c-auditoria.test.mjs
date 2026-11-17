import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const ler = (nome) => readFile(new URL("../" + nome, import.meta.url), "utf8");
const EVENTOS = [
  "booking_flow_started", "booking_date_selected",
  "booking_suggestions_displayed", "booking_suggestion_selected",
  "booking_all_times_opened", "booking_time_selected",
  "booking_submit_clicked", "booking_quote_viewed",
  "booking_pix_qr_shown", "booking_pix_confirmed_ui",
  "booking_exempt_confirmed_ui", "booking_reschedule_completed_ui",
];

async function executar(camadas) {
  const script = await ler("scripts/ga4-2c-auditoria-console.js");
  const saida = [];
  const window = { dataLayer: camadas, location: { pathname: "/agendamento.html" } };
  const console = {
    info(...args) { saida.push(args); },
    table(valor) { saida.push(valor); },
  };
  runInNewContext(script, { window, console, URL });
  const resultado = window.__isabeleGA4Auditoria();
  return { resultado, saida: JSON.stringify(saida) };
}
const config = ["config", "G-ZFCQC4FFJS", { send_page_view: false }];
const parametros = {
  actor_role: "client", flow_type: "new", service_category: "manicure",
  analytics_schema_version: 1,
  page_location: "https://example.org/agendamento.html",
  page_referrer: "https://example.org/principal.html",
};

test("2C: cobre exatamente os 12 eventos contratados nas fases 2A/2B", async () => {
  const core = await ler("bookingAnalytics.mjs");
  const nomesCodigo = [...core.matchAll(/"booking_[a-z_]+"/g)].map((m) => m[0].slice(1, -1));
  for (const nome of EVENTOS) assert.ok(nomesCodigo.includes(nome), nome);
  const { resultado } = await executar([config]);
  assert.equal(resultado.eventos.length, 12);
  assert.deepEqual(Array.from(resultado.nomesNaoObservados), EVENTOS);
  assert.equal(resultado.alertas.length, 0);
});

test("2C: relatório não imprime valores de cliente, reserva, telefone ou e-mail", async () => {
  const params = { ...parametros, user_email: "cliente@exemplo.com", outra_chave: "token=segredo" };
  const { resultado, saida } = await executar([
    config, ["event", "booking_flow_started", params],
  ]);
  assert.ok(resultado.alertas.some((x) => x.codigo === "parametro_nao_previsto"));
  assert.ok(resultado.alertas.some((x) => x.codigo === "possivel_dado_pessoal"));
  assert.doesNotMatch(saida, /cliente@exemplo.com|token=segredo|user_email|outra_chave/);
});

test("2C: valida eventos de checkout sem confundir QR com confirmação", async () => {
  const { resultado } = await executar([
    config,
    ["event", "booking_flow_started", parametros],
    ["event", "booking_submit_clicked", parametros],
    ["event", "booking_quote_viewed", { ...parametros, payment_path: "pix" }],
    ["event", "booking_pix_qr_shown", { ...parametros, payment_path: "pix" }],
  ]);
  const contar = (nome) => resultado.eventos.find((e) => e.evento === nome).ocorrencias;
  assert.equal(contar("booking_pix_qr_shown"), 1);
  assert.equal(contar("booking_pix_confirmed_ui"), 0);
  assert.equal(resultado.alertas.length, 0);
});

test("2C: alerta para URL sensível e parâmetros de pagamento incorretos", async () => {
  const { resultado } = await executar([
    config,
    ["event", "booking_time_selected", {
      ...parametros,
      page_location: "https://exemplo.org/agendamento.html?reagendar=privado",
      selection_source: "suggestion", time_bucket: "evening",
    }],
    ["event", "booking_pix_confirmed_ui", { ...parametros, payment_path: "exempt" }],
  ]);
  assert.ok(resultado.alertas.some((x) => x.codigo === "url_com_parametros_ou_fragmento"));
  assert.ok(resultado.alertas.some((x) => x.codigo === "caminho_pagamento_invalido"));
});

test("2C: sinaliza duplicação e não envia eventos pela auditoria", async () => {
  const camada = [
    config,
    ["event", "booking_flow_started", parametros],
    ["event", "booking_flow_started", parametros],
    ["event", "booking_suggestions_displayed", parametros],
    ["event", "booking_suggestions_displayed", parametros],
  ];
  const originalCount = camada.length;
  const { resultado } = await executar(camada);
  assert.equal(camada.length, originalCount);
  assert.ok(resultado.alertas.some((x) => x.codigo === "multiplo_inicio_na_mesma_pagina"));
  assert.ok(resultado.alertas.some((x) => x.codigo === "multiplas_exibicoes_na_mesma_pagina"));
});

test("2C: relatório não marca passos não executados como falha de coleta", async () => {
  const { resultado } = await executar([config, ["event", "booking_flow_started", parametros]]);
  assert.equal(resultado.alertas.length, 0);
  assert.ok(resultado.nomesNaoObservados.includes("booking_pix_confirmed_ui"));
  assert.match(resultado.avisos[0], /não é falha/);
});

test("2C: diagnostica papel diferente e reagendamento marcado como novo", async () => {
  const { resultado } = await executar([
    config,
    ["event", "booking_flow_started", { ...parametros, actor_role: "admin" }],
    ["event", "booking_reschedule_completed_ui", { ...parametros, flow_type: "new" }],
  ]);
  assert.ok(resultado.alertas.some((x) => x.codigo === "papel_diferente_de_cliente"));
  assert.ok(resultado.alertas.some((x) => x.codigo === "reagendamento_como_nova_reserva"));
});
