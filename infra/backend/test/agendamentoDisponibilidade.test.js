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

const AGORA = new Date("2026-10-22T12:00:00Z");
const conferir = (data, horario, duracao, esperado) =>
  assert.equal(
    validarHorarioPix(data, horario, duracao, AGORA).valido,
    esperado,
    `${data} ${horario} (${duracao} min)`,
  );

test("quinta encerra atendimento às 19h e não gera horários posteriores", () => {
  const limites = obterLimitesAtendimentoSemanal(4);
  assert.deepEqual(limites, {
    minAbertura: 660,
    minUltimoInicio: 1110,
    minFechamento: 1140,
  });
  for (const [horario, duracao] of [["11:00", 120], ["12:00", 60], ["12:30", 60], ["13:00", 30], ["14:00", 120], ["18:00", 60], ["18:30", 30]]) {
    conferir("2026-11-05", horario, duracao, true);
  }
  for (const [horario, duracao] of [["09:00", 60], ["10:30", 60], ["12:00", 120], ["13:00", 60], ["13:30", 30], ["18:30", 60], ["19:00", 30], ["19:30", 60]]) {
    conferir("2026-11-05", horario, duracao, false);
  }
});

test("sexta também encerra atendimento às 19h", () => {
  const limites = obterLimitesAtendimentoSemanal(5);
  assert.deepEqual(limites, {
    minAbertura: 540,
    minUltimoInicio: 1110,
    minFechamento: 1140,
  });
  for (const [horario, duracao] of [["09:00", 120], ["11:30", 60], ["12:00", 60], ["12:30", 60], ["13:00", 30], ["14:00", 120], ["18:00", 60], ["18:30", 30]]) {
    conferir("2026-11-06", horario, duracao, true);
  }
  for (const [horario, duracao] of [["12:00", 120], ["13:00", 60], ["13:30", 30], ["18:30", 60], ["19:00", 30], ["19:30", 60]]) {
    conferir("2026-11-06", horario, duracao, false);
  }
});

test("sábado mantém encerramento às 18h com exceção às 16h para 150 min", () => {
  const limites = obterLimitesAtendimentoSemanal(6);
  assert.deepEqual(limites, {
    minAbertura: 540,
    minUltimoInicio: 1020,
    minFechamento: 1110,
  });
  for (const [horario, duracao] of [
    ["09:00", 120], ["12:00", 120], ["13:00", 60],
    ["13:30", 30], ["13:30", 120], ["14:00", 120],
    ["15:00", 30], ["15:00", 60],
    ["15:30", 30], ["15:30", 60],
    ["16:00", 60], ["16:00", 90], ["16:00", 120], ["16:00", 150],
    ["16:30", 90], ["17:00", 30], ["17:00", 60],
  ]) {
    conferir("2026-11-07", horario, duracao, true);
  }
  for (const [horario, duracao] of [
    ["15:00", 90], ["15:30", 90],
    ["16:00", 30], ["16:00", 151], ["16:00", 180],
    ["14:00", 270], ["14:30", 240],
    ["16:30", 30], ["16:30", 60], ["16:30", 120],
    ["17:00", 90], ["17:30", 30], ["23:00", 120],
  ]) {
    conferir("2026-11-07", horario, duracao, false);
  }
});

test("pausa de almoço continua nos dias úteis e não bloqueia o sábado", () => {
  for (const data of ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]) {
    for (const duracao of [30, 60, 120]) {
      conferir(data, "13:30", duracao, false);
    }
    conferir(data, "14:00", 30, true);
  }
  for (const data of ["2026-11-05", "2026-11-06"]) {
    conferir(data, "12:00", 60, true);
    conferir(data, "12:30", 60, true);
    conferir(data, "13:00", 30, true);
    conferir(data, "12:00", 120, false);
    conferir(data, "13:00", 60, false);
  }
  conferir("2026-11-07", "12:00", 120, true);
  conferir("2026-11-07", "13:00", 60, true);
  conferir("2026-11-07", "13:30", 60, true);
});
