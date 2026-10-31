import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { adicionarMesCalendario, obterJanelaAgendamento, obterMesesGerenciaveis, validarDataGerenciavel, validarDataNaJanela, validarHorarioEspecial, listarSlotsGerenciaveis } from "../infra/backend/src/agendamentoRegras.mjs";

const dataDoDia = (diaSemana, referencia = "2026-11-01") => {
  const data = new Date(`${referencia}T12:00:00Z`);
  while (data.getUTCDay() !== diaSemana) data.setUTCDate(data.getUTCDate() + 1);
  return data.toISOString().slice(0, 10);
};

test("janela móvel inicia na abertura de novembro e avança por um mês de calendário", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.deepEqual(obterJanelaAgendamento(now), { inicio: "2026-11-01", fim: "2026-11-22" });
  assert.equal(validarDataNaJanela("2026-11-21", now).valido, true);
  assert.equal(validarDataNaJanela("2026-11-23", now).valido, false);
});

test("cálculo mensal trata final de mês, fevereiro bissexto e virada do ano", () => {
  assert.equal(adicionarMesCalendario("2027-01-31"), "2027-02-28");
  assert.equal(adicionarMesCalendario("2028-01-31"), "2028-02-29");
  assert.equal(adicionarMesCalendario("2026-12-31"), "2027-01-31");
});

test("dezembro de 2026 permanece fechado, mesmo dentro da janela móvel", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  assert.equal(validarDataNaJanela("2026-12-10", now).valido, false);
});

test("admin pode gerenciar mês atual e dois seguintes sem abrir dezembro às clientes", () => {
  const agora = new Date("2026-10-26T15:00:00Z");
  assert.deepEqual(obterMesesGerenciaveis(agora).map(({ chave }) => chave), [
    "2026-10", "2026-11", "2026-12",
  ]);
  assert.equal(validarDataGerenciavel("2026-10-25", agora).valido, false);
  assert.equal(validarDataGerenciavel("2026-10-26", agora).valido, true);
  assert.equal(validarDataGerenciavel("2026-12-31", agora).valido, true);
  assert.equal(validarDataGerenciavel("2027-01-01", agora).valido, false);
  assert.equal(validarDataNaJanela("2026-12-03", agora).valido, false);
  assert.ok(listarSlotsGerenciaveis("2026-12-03", agora).includes(660));
});

test("janela administrativa cruza dezembro e janeiro sem ano fixo", () => {
  const meses = obterMesesGerenciaveis(new Date("2026-12-31T15:00:00Z"));
  assert.deepEqual(meses.map(({ chave, inicio, fim }) => ({ chave, inicio, fim })), [
    { chave: "2026-12", inicio: "2026-12-31", fim: "2026-12-31" },
    { chave: "2027-01", inicio: "2027-01-01", fim: "2027-01-31" },
    { chave: "2027-02", inicio: "2027-02-01", fim: "2027-02-28" },
  ]);
  assert.equal(validarDataGerenciavel("2027-01-01", new Date("2026-12-31T15:00:00Z")).valido, true);
});

test("terça oferece apenas 14:00, 14:30 e 15:00, com término até 17:30", () => {
  const date = dataDoDia(2);
  for (const time of ["14:00", "14:30", "15:00"]) assert.equal(validarHorarioEspecial(date, time, 60), true, time);
  for (const time of ["13:30", "15:30", "16:00"]) assert.equal(validarHorarioEspecial(date, time, 60), false, time);
  for (const duracao of [30, 60, 90, 120]) assert.equal(validarHorarioEspecial(date, "15:30", duracao), false, `${duracao} min`);
  assert.equal(validarHorarioEspecial(date, "15:00", 150), true);
  assert.equal(validarHorarioEspecial(date, "15:00", 151), false);
});

test("quarta oferece somente 09:00 e 14:00 respeitando os dois limites", () => {
  const date = dataDoDia(3);
  assert.equal(validarHorarioEspecial(date, "09:00", 210), true);
  assert.equal(validarHorarioEspecial(date, "09:00", 211), false);
  assert.equal(validarHorarioEspecial(date, "14:00", 210), true);
  assert.equal(validarHorarioEspecial(date, "14:00", 211), false);
  for (const time of ["09:30", "10:00", "11:00", "13:30", "14:30", "15:00"]) assert.equal(validarHorarioEspecial(date, time, 60), false, time);
});

test("terça, quarta, quinta, sexta e sábado mantêm os slots administrativos", () => {
  const agora = new Date("2026-10-22T12:00:00Z");
  assert.deepEqual(listarSlotsGerenciaveis(dataDoDia(2), agora).slice(0, 2), [840, 870]);
  assert.deepEqual(listarSlotsGerenciaveis(dataDoDia(3), agora).slice(0, 2), [540, 570]);
  for (const weekday of [4, 5, 6]) assert.equal(validarHorarioEspecial(dataDoDia(weekday), "16:00", 60), true);
  assert.equal(listarSlotsGerenciaveis(dataDoDia(6), agora).includes(960), true);
  for (const dia of [4, 5]) {
    const slots = listarSlotsGerenciaveis(dataDoDia(dia), agora);
    assert.equal(slots.includes(1110), true);
    assert.equal(slots.includes(1140), false);
  }
  const slotsSabado = listarSlotsGerenciaveis(dataDoDia(6), agora);
  assert.equal(slotsSabado.includes(810), true); // sábado sem almoço fixo
  assert.equal(slotsSabado.includes(1050), true); // 17h30–18h gerenciável
  assert.equal(slotsSabado.includes(1080), false);
});

import { validarHorarioPix } from "../infra/backend/src/pixDisponibilidade.js";

test("validador backend PIX aplica terça, quarta, fechamento e bloqueio de dezembro", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  for (const horario of ["14:00", "14:30", "15:00"]) assert.equal(validarHorarioPix("2026-11-03", horario, 60, now).valido, true, horario);
  assert.equal(validarHorarioPix("2026-11-03", "13:30", 60, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-03", "15:30", 60, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-03", "15:30", 121, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-04", "09:00", 210, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-04", "09:00", 211, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-04", "14:00", 210, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-04", "14:30", 60, now).valido, false);
  assert.equal(validarHorarioPix("2026-12-02", "14:00", 60, now).valido, false);
});

test("backend PIX respeita os novos limites e horários especiais de sábado", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  for (const data of ["2026-11-05", "2026-11-06"]) {
    assert.equal(validarHorarioPix(data, "18:00", 60, now).valido, true);
    assert.equal(validarHorarioPix(data, "18:30", 60, now).valido, false);
    assert.equal(validarHorarioPix(data, "19:00", 30, now).valido, false);
  }
  for (const [horario, duracao] of [["13:30", 90], ["15:00", 60], ["15:30", 60], ["16:00", 60], ["16:00", 90], ["16:00", 120], ["16:30", 90], ["17:00", 60]]) {
    assert.equal(validarHorarioPix("2026-11-07", horario, duracao, now).valido, true, horario);
  }
  for (const [horario, duracao] of [["15:00", 90], ["15:30", 90], ["16:00", 30], ["16:30", 60], ["17:00", 90], ["17:30", 30]]) {
    assert.equal(validarHorarioPix("2026-11-07", horario, duracao, now).valido, false, horario);
  }
});



test("API de disponibilidade bloqueia datas fora da janela antes de consultar o banco", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(path.join(root, "infra/backend/src/pixDisponibilidadeApi.js"), "utf8");
  const guard = source.indexOf("validarDataNaJanela(data, dependencies.now || new Date())");
  const query = source.indexOf("pool.query(");
  assert.ok(guard >= 0 && guard < query);
});
