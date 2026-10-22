import test from "node:test";
import assert from "node:assert/strict";
import { adicionarMesCalendario, calcularJanelaMensal, estaNaJanelaMensal } from "./agendaJanela.js";

test("a janela móvel inclui o mesmo dia do mês seguinte e cruza meses", () => {
  const agora = new Date("2026-10-25T12:00:00-03:00");
  assert.deepEqual(calcularJanelaMensal(agora), { inicio: "2026-10-25", fim: "2026-11-25" });
  const dataManutencao = new Date(Date.UTC(2026, 9, 25 + 20)).toISOString().slice(0, 10);
  assert.equal(dataManutencao, "2026-11-14");
  assert.equal(estaNaJanelaMensal(dataManutencao, agora), true);
  assert.equal(estaNaJanelaMensal("2026-11-26", agora), false);
});

test("a janela respeita meses curtos, anos bissextos e viradas de ano", () => {
  assert.equal(adicionarMesCalendario("2024-01-31"), "2024-02-29");
  assert.equal(adicionarMesCalendario("2025-01-31"), "2025-02-28");
  assert.equal(adicionarMesCalendario("2026-12-31"), "2027-01-31");
  assert.equal(adicionarMesCalendario("2026-03-31", -1), "2026-02-28");
  assert.equal(estaNaJanelaMensal("2026-02-30", new Date("2026-02-01T12:00:00-03:00")), false);
});

test("a data é calculada pelo dia civil de São Paulo, independentemente do fuso do servidor", () => {
  const instante = new Date("2026-10-22T02:30:00Z");
  assert.deepEqual(calcularJanelaMensal(instante), { inicio: "2026-10-21", fim: "2026-11-21" });
});
