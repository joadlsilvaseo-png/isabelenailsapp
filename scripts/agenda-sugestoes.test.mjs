import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { escolherDiasSemana, sugerirHorarios } from "../agendaSugestoes.mjs";

const terca = "2026-11-17";
const quarta = "2026-11-18";
const servico = { nome: "Manicure em gel", categoria: "Manicure" };
const agenda = (data, horario, duracao = 60, extras = {}) =>
  ({ data, horario, duracao, status: "confirmado", ...extras });

test("seleciona somente os próximos sete dias corridos e não duplica datas", () => {
  assert.deepEqual(escolherDiasSemana([
    "2026-11-16", terca, terca, quarta, "2026-11-23", "2026-11-24",
  ], terca), [terca, quarta, "2026-11-23"]);
});

test("prioriza 15 minutos depois do término sem obrigar esse intervalo", () => {
  const r = sugerirHorarios({
    datas: [terca], hoje: terca, servico, duracao: 60,
    agendamentos: [agenda(terca, "14:00")],
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].horarios[0], "15:15");
  assert.equal(r[0].horarios.includes("15:00"), false);
});

test("rejeita conflito real e encaixa duração exata antes do próximo", () => {
  const r = sugerirHorarios({
    datas: [terca], hoje: terca, servico, duracao: 60,
    agendamentos: [agenda(terca, "14:00"), agenda(terca, "16:15")],
  });
  assert.equal(r[0].horarios[0], "15:15");
  assert.equal(r[0].horarios.includes("15:30"), false);
});

test("usa apenas dados ativos e omite horários que já passaram hoje", () => {
  const r = sugerirHorarios({
    datas: [terca], hoje: terca, servico, duracao: 30, minutoAtual: 16 * 60,
    agendamentos: [agenda(terca, "16:30", 30, { status: "cancelado" })],
  });
  assert.ok(r[0].horarios.every((h) => Number(h.slice(0, 2)) * 60 +
    Number(h.slice(3)) > 16 * 60));
});

test("respeita janelas separadas e duração integral do serviço", () => {
  const r = sugerirHorarios({
    datas: [quarta], hoje: quarta, servico, duracao: 150, agendamentos: [],
  });
  assert.ok(r[0].horarios.every((h) => h >= "14:00" && h <= "15:00"));
});

test("exceções de dezembro: dia fechado e serviço suspenso não são sugeridos", () => {
  const r = sugerirHorarios({
    datas: ["2026-12-15", "2026-12-17"], hoje: "2026-12-15",
    servico: { nome: "Pedicure simples", categoria: "Pedicure" },
    duracao: 60, agendamentos: [],
  });
  assert.deepEqual(r, []);
});

test("respeita serviço consecutivo da mesma cliente sem mudar proteção para outras", () => {
  const r = sugerirHorarios({
    datas: [terca], hoje: terca, servico, duracao: 60, clienteId: "cliente-a",
    agendamentos: [agenda(terca, "14:00", 60, { clienteId: "cliente-a" })],
    maxPorDia: 3,
  });
  assert.ok(r[0].horarios.includes("15:15"));
});

test("integração mantém o calendário e consulta PIX somente ao selecionar", async () => {
  const page = await readFile(new URL("../agendamento.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../agendamento.html", import.meta.url), "utf8");
  assert.match(page, /agendaSugestoes\.mjs/);
  assert.match(page, /where\("data", ">=", diasSemana\[0\]\)/);
  assert.match(page, /selecionarDataAgendamento\(botaoData, botao\.dataset\.time\)/);
  assert.match(page, /await renderizarHorarios\(dataIso, serviceDuration, reagendarId, serviceInfo\)/);
  assert.match(html, /id="agenda-sugestoes"/);
  assert.match(html, /class="agendamento-calendar"/);
});
