import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { definirBloqueioTurnos } from "../agendamentoSugestaoFluxo.mjs";

function botao(disabled = false) {
  const atributos = {};
  return {
    disabled, dataset: {},
    setAttribute(nome, valor) { atributos[nome] = valor; },
    removeAttribute(nome) { delete atributos[nome]; },
    getAttribute(nome) { return atributos[nome]; },
  };
}
function montarTurnos(...botoes) {
  const classes = new Set();
  return {
    classes,
    classList: { toggle(nome, ativo) { ativo ? classes.add(nome) : classes.delete(nome); } },
    querySelectorAll(seletor) { assert.equal(seletor, ".agendamento-time"); return botoes; },
  };
}
test("trava horários manuais preservando o agendado que já estava indisponível", () => {
  const livre = botao(), selecionado = botao(), reservado = botao(true);
  const turnos = montarTurnos(livre, selecionado, reservado);
  const toggle = botao();
  definirBloqueioTurnos(turnos, true, toggle);
  assert.equal(turnos.classes.has("agendamento-times--sugestao-selecionada"), true);
  for (const b of [livre, selecionado, reservado]) assert.equal(b.disabled, true);
  assert.equal(toggle.disabled, true);
  assert.equal(livre.dataset.bloqueioSugestao, "true");
  assert.equal(selecionado.dataset.bloqueioSugestao, "true");
  assert.equal(reservado.dataset.bloqueioSugestao, undefined);
  definirBloqueioTurnos(turnos, false, toggle);
  assert.equal(livre.disabled, false);
  assert.equal(selecionado.disabled, false);
  assert.equal(reservado.disabled, true, "nunca libera um horário realmente ocupado");
  assert.equal(toggle.disabled, false);
  assert.equal(livre.dataset.bloqueioSugestao, undefined);
  assert.equal(livre.getAttribute("aria-disabled"), undefined);
});

test("pode reaplicar o bloqueio sem perder marcadores e aceita contêiner ausente", () => {
  const b=botao(), turnos=montarTurnos(b);
  definirBloqueioTurnos(turnos, true);
  definirBloqueioTurnos(turnos, true);
  definirBloqueioTurnos(turnos, false);
  assert.equal(b.disabled, false);
  assert.doesNotThrow(() => definirBloqueioTurnos(null, true));
});

test("avança até comentários somente após seleção efetivamente validada", async () => {
  const pagina = await readFile(new URL("../agendamento.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../agendamento.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../agendamento.html", import.meta.url), "utf8");
  assert.match(pagina, /const selecionado = await selecionarDataAgendamento\(botaoData, botao\.dataset\.time\)/);
  assert.match(pagina, /if \(selecionado\) \{/);
  assert.match(pagina, /destino\.scrollIntoView/);
  assert.match(pagina, /if \(!opcao\) return false/);
  assert.match(pagina, /!opcao\.classList\.contains\("agendamento-time--active"\)/);
  assert.match(pagina, /definirBloqueioTurnos\(horariosContainer, true, alternarIndisponiveis\)/);
  assert.match(pagina, /liberarHorariosManuais\(\)/);
  assert.match(pagina, /sequenciaSelecao/);
  assert.match(pagina, /atualizarAoRetornar/);
  assert.match(html, /class="agendamento-comments"/);
  assert.match(html, /Confirmar agendamento/i);
  assert.match(css, /agendamento-times--sugestao-selecionada/);
});
