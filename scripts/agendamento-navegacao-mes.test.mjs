import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { obterMesPredominante } from "../agendamentoMes.mjs";

const cartoes = [
  { mes: "2026-11", inicio: 0, fim: 64 },
  { mes: "2026-11", inicio: 73, fim: 137 },
  { mes: "2026-12", inicio: 146, fim: 210 },
  { mes: "2026-12", inicio: 219, fim: 283 },
  { mes: "2026-12", inicio: 292, fim: 356 },
];

test("mês indica novembro quando novembro ocupa a maior parte da roleta", () => {
  assert.equal(obterMesPredominante(cartoes, 0, 205), "2026-11");
});

test("mês passa a dezembro ao deslizar sem clicar numa data", () => {
  assert.equal(obterMesPredominante(cartoes, 112, 356), "2026-12");
});

test("retorna nulo com calendário vazio ou fora da tela", () => {
  assert.equal(obterMesPredominante([], 0, 200), null);
  assert.equal(obterMesPredominante(cartoes, 500, 700), null);
  assert.equal(obterMesPredominante(cartoes, 0, 0), null);
});

test("HTML e JS oferecem seletor de mês sem trocar a data escolhida", async () => {
  const html = await readFile(new URL("../agendamento.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../agendamento.js", import.meta.url), "utf8");
  assert.match(html, /<select id="calendar-month-label"/);
  assert.match(js, /container\.addEventListener\("scroll"/);
  assert.match(js, /seletor\.addEventListener\("change"/);
  assert.match(js, /obterMesPredominante\(/);
  assert.match(js, /selecionarUnico\(botao, datas, "agendamento-date--active"\)/);
});
