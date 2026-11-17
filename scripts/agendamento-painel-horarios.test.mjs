import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { configurarPainelHorarios } from "../agendamentoPainelHorarios.mjs";

function simularPainel(opcoes = {}) {
  const eventos = new Map();
  const atributos = {};
  const rotulo = { textContent: "" };
  const painel = { hidden: false };
  const botao = {
    querySelector(seletor) {
      assert.equal(seletor, "[data-horarios-toggle-texto]");
      return rotulo;
    },
    addEventListener(tipo, fn) { eventos.set(tipo, fn); },
    setAttribute(chave, valor) { atributos[chave] = valor; },
  };
  const api = configurarPainelHorarios(botao, painel, opcoes);
  return { api, painel, rotulo, atributos, tocar: () => eventos.get("click")() };
}

test("horários convencionais começam recolhidos, preservando botão acessível", () => {
  const { api, painel, rotulo, atributos } = simularPainel();
  assert.equal(api.estaAberto(), false);
  assert.equal(painel.hidden, true);
  assert.equal(atributos["aria-expanded"], "false");
  assert.equal(rotulo.textContent, "Ver todos os horários");
});

test("abre e recolhe sem regenerar horários nem alterar disponibilidade", () => {
  const { api, painel, rotulo, atributos, tocar } = simularPainel();
  tocar();
  assert.equal(api.estaAberto(), true);
  assert.equal(painel.hidden, false);
  assert.equal(atributos["aria-expanded"], "true");
  assert.equal(rotulo.textContent, "Recolher horários");
  tocar();
  assert.equal(api.estaAberto(), false);
  assert.equal(painel.hidden, true);
  assert.equal(rotulo.textContent, "Ver todos os horários");
});

test("ao selecionar uma sugestão válida, recolhe; reabre normalmente depois", () => {
  const { api, tocar, painel } = simularPainel();
  tocar();
  api.recolher();
  assert.equal(painel.hidden, true);
  tocar();
  assert.equal(painel.hidden, false);
});

test("não quebra se o botão ou painel estiver ausente", () => {
  const api = configurarPainelHorarios(null, null);
  assert.doesNotThrow(() => api.recolher());
  assert.equal(api.estaAberto(), false);
});

test("fluxo e acessibilidade integram toggle sem remover carrosséis existentes", async () => {
  const html = await readFile(new URL("../agendamento.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../agendamento.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../agendamento.css", import.meta.url), "utf8");
  assert.match(html, /id="agendamento-horarios-toggle"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="agendamento-horarios-painel"/);
  assert.match(html, /id="agendamento-horarios-painel"[^>]*hidden/);
  assert.match(html, /id="agendamento-ver-indisponiveis"/);
  assert.match(html, /id="horarios-agendamento"/);
  assert.match(js, /configurarPainelHorarios/);
  assert.match(js, /painelHorarios\.recolher\(\)/);
  assert.match(js, /await renderizarHorarios\(dataIso, serviceDuration, reagendarId, serviceInfo, idConsultaPix\)/);
  assert.match(css, /\.agendamento-horarios-painel\[hidden\]/);
  assert.match(css, /agendamento-time-carousel/);
});

test("telemetria só registra abertura por clique: iniciar/recolher/expandir não contam", () => {
  let aberturas = 0;
  const { api, tocar } = simularPainel({ aoAbrir: () => { aberturas += 1; } });
  assert.equal(aberturas, 0);
  api.expandir();
  assert.equal(aberturas, 0);
  api.recolher();
  tocar();
  assert.equal(aberturas, 1);
  tocar();
  assert.equal(aberturas, 1);
  tocar();
  assert.equal(aberturas, 2);
});

test("falha na instrumentação não altera abertura ou acessibilidade", () => {
  const { api, tocar, atributos } = simularPainel({ aoAbrir() { throw Error("offline"); } });
  assert.doesNotThrow(tocar);
  assert.equal(api.estaAberto(), true);
  assert.equal(atributos["aria-expanded"], "true");
});
