import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { adicionarMesCalendario, obterJanelaAgendamento, validarDataNaJanela, validarHorarioEspecial } from "../infra/backend/src/agendamentoRegras.mjs";

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

test("terça oferece exclusivamente inícios de 14:00 a 15:30 e encerra até 17:30", () => {
  const date = dataDoDia(2);
  for (const time of ["14:00", "14:30", "15:00", "15:30"]) assert.equal(validarHorarioEspecial(date, time, 60), true, time);
  for (const time of ["13:30", "16:00", "15:30"]) {
    if (time === "15:30") assert.equal(validarHorarioEspecial(date, time, 121), false);
    else assert.equal(validarHorarioEspecial(date, time, 60), false, time);
  }
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

test("quinta, sexta e sábado passam pela regra semanal inalterada", () => {
  for (const weekday of [4, 5, 6]) assert.equal(validarHorarioEspecial(dataDoDia(weekday), "16:00", 60), true);
});

import { validarHorarioPix } from "../infra/backend/src/pixDisponibilidade.js";

test("validador backend PIX aplica terça, quarta, fechamento e bloqueio de dezembro", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(validarHorarioPix("2026-11-03", "14:00", 60, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-03", "13:30", 60, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-03", "15:30", 121, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-04", "09:00", 210, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-04", "09:00", 211, now).valido, false);
  assert.equal(validarHorarioPix("2026-11-04", "14:00", 210, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-04", "14:30", 60, now).valido, false);
  assert.equal(validarHorarioPix("2026-12-02", "14:00", 60, now).valido, false);
});

test("quinta, sexta e sábado conservam o validador anterior, inclusive o último início de sábado", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(validarHorarioPix("2026-11-05", "18:30", 120, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-06", "18:30", 120, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-07", "16:00", 60, now).valido, true);
  assert.equal(validarHorarioPix("2026-11-07", "16:30", 60, now).valido, false);
});



test("API de disponibilidade bloqueia datas fora da janela antes de consultar o banco", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(path.join(root, "infra/backend/src/pixDisponibilidadeApi.js"), "utf8");
  const guard = source.indexOf("validarDataNaJanela(data, dependencies.now || new Date())");
  const query = source.indexOf("pool.query(");
  assert.ok(guard >= 0 && guard < query);
});
