import test from "node:test";
import assert from "node:assert/strict";
import {
  consultarIntervalosDisponibilidade,
  intervaloSobrepoeDisponibilidade,
  obterLimitesAtendimentoSemanal,
} from "../../../agendamentoDisponibilidade.js";
import { validarHorarioPix } from "../src/pixDisponibilidade.js";

test("combina reservas PIX pendentes e agendamentos do Firestore", async () => {
  const intervalos = await consultarIntervalosDisponibilidade({
    consultarAgendamentosFirestore: async () => [{ inicioMinuto: 600, fimMinuto: 660 }],
    consultarReservasPix: async () => [{ inicioMinuto: 810, fimMinuto: 930 }],
  });
  assert.deepEqual(intervalos, [
    { inicioMinuto: 600, fimMinuto: 660 },
    { inicioMinuto: 810, fimMinuto: 930 },
  ]);
});

test("reserva de duas horas bloqueia sobreposições e libera o horário exato do término", () => {
  const reservas = [{ inicioMinuto: 810, fimMinuto: 930 }];
  assert.equal(intervaloSobrepoeDisponibilidade(780, 840, reservas), true);
  assert.equal(intervaloSobrepoeDisponibilidade(900, 960, reservas), true);
  assert.equal(intervaloSobrepoeDisponibilidade(930, 990, reservas), false);
});

test("falha de rede em uma fonte rejeita toda a disponibilidade e não libera horários", async () => {
  await assert.rejects(consultarIntervalosDisponibilidade({
    consultarAgendamentosFirestore: async () => [],
    consultarReservasPix: async () => { throw new Error("API indisponível"); },
  }), /API indisponível/);
});

test("resposta inválida da API falha fechada", async () => {
  await assert.rejects(consultarIntervalosDisponibilidade({
    consultarAgendamentosFirestore: async () => [],
    consultarReservasPix: async () => [{ inicioMinuto: 930, fimMinuto: 810 }],
  }), /intervalo inválido/);
});

test("quinta libera inícios das 11h às 19h, sem bloqueio de almoço", () => {
  const limites = obterLimitesAtendimentoSemanal(4);
  assert.deepEqual(limites, {
    minAbertura: 660,
    minUltimoInicio: 1140,
    minFechamento: 1260,
    permitirInicioAoMeioDia: true,
  });
  for (const horario of ["11:00", "12:00", "12:30", "19:00"]) {
    assert.equal(validarHorarioPix("2026-11-05", horario, 120).valido, true, horario);
  }
  for (const horario of ["09:00", "10:30", "19:30"]) {
    assert.equal(validarHorarioPix("2026-11-05", horario, 60).valido, false, horario);
  }
  assert.equal(validarHorarioPix("2026-11-05", "19:00", 150).valido, false);
});

test("sexta libera inícios das 9h às 19h, incluindo almoço", () => {
  const limites = obterLimitesAtendimentoSemanal(5);
  assert.equal(limites.minAbertura, 540);
  assert.equal(limites.minUltimoInicio, 1140);
  assert.equal(limites.minFechamento, 1260);
  for (const horario of ["09:00", "12:00", "12:30", "19:00"]) {
    assert.equal(validarHorarioPix("2026-11-06", horario, 120).valido, true, horario);
  }
  assert.equal(validarHorarioPix("2026-11-06", "19:30", 60).valido, false);
});

test("mantém as regras de segunda, terça, quarta, sábado e dezembro", () => {
  assert.equal(validarHorarioPix("2026-11-02", "13:30", 60).valido, false);
  assert.equal(validarHorarioPix("2026-11-03", "13:30", 60).valido, true);
  assert.equal(validarHorarioPix("2026-11-03", "09:00", 60).valido, false);
  assert.equal(validarHorarioPix("2026-11-04", "13:30", 120).valido, true);
  assert.equal(validarHorarioPix("2026-11-07", "09:00", 60).valido, true);
  assert.equal(validarHorarioPix("2026-12-03", "11:00", 60).valido, false);
  assert.equal(obterLimitesAtendimentoSemanal(2).minUltimoInicio, 1080);
  assert.equal(obterLimitesAtendimentoSemanal(6).minFechamento, 1200);
});
