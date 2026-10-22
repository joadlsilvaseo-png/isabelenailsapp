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

test("quinta abre às 11h e permite último início às 19h", () => {
  const limites = obterLimitesAtendimentoSemanal(4);
  assert.deepEqual(limites, {
    minAbertura: 660,
    minUltimoInicio: 1140,
    minFechamento: 1260,
  });
  for (const [horario, duracao] of [["11:00", 120], ["12:00", 60], ["12:30", 60], ["13:00", 30], ["14:00", 120], ["19:00", 60]]) {
    assert.equal(validarHorarioPix("2026-11-05", horario, duracao).valido, true, horario + " (" + duracao + " min)");
  }
  for (const [horario, duracao] of [["09:00", 60], ["10:30", 60], ["12:00", 120], ["13:00", 60], ["13:30", 30], ["19:30", 60]]) {
    assert.equal(validarHorarioPix("2026-11-05", horario, duracao).valido, false, horario + " (" + duracao + " min)");
  }
  assert.equal(validarHorarioPix("2026-11-05", "19:00", 150).valido, false);
});

test("sexta segue das 9h às 19h, com almoço fechado", () => {
  const limites = obterLimitesAtendimentoSemanal(5);
  assert.deepEqual(limites, {
    minAbertura: 540,
    minUltimoInicio: 1140,
    minFechamento: 1260,
  });
  for (const [horario, duracao] of [["09:00", 120], ["11:30", 60], ["12:00", 60], ["12:30", 60], ["13:00", 30], ["14:00", 120], ["19:00", 60]]) {
    assert.equal(validarHorarioPix("2026-11-06", horario, duracao).valido, true, horario + " (" + duracao + " min)");
  }
  for (const [horario, duracao] of [["12:00", 120], ["13:00", 60], ["13:30", 30], ["19:30", 60]]) {
    assert.equal(validarHorarioPix("2026-11-06", horario, duracao).valido, false, horario + " (" + duracao + " min)");
  }
});

test("sábado permite início de agendamento até 16h", () => {
  const limites = obterLimitesAtendimentoSemanal(6);
  assert.deepEqual(limites, {
    minAbertura: 540,
    minUltimoInicio: 960,
    minFechamento: 1440,
  });
  for (const [horario, duracao] of [["09:00", 120], ["12:00", 60], ["12:30", 60], ["13:00", 30], ["14:00", 120], ["15:00", 60], ["15:30", 60], ["16:00", 120]]) {
    assert.equal(validarHorarioPix("2026-11-07", horario, duracao).valido, true, horario + " (" + duracao + " min)");
  }
  for (const [horario, duracao] of [["12:00", 120], ["13:00", 60], ["13:30", 30], ["16:30", 30], ["17:00", 30], ["23:00", 120]]) {
    assert.equal(validarHorarioPix("2026-11-07", horario, duracao).valido, false, horario + " (" + duracao + " min)");
  }
});

test("cliente consegue reservar manutenção 20 dias depois dentro da janela mensal", () => {
  const agora = new Date("2026-10-25T12:00:00-03:00");
  assert.equal(validarHorarioPix("2026-11-14", "09:00", 120, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-25", "09:00", 60, agora).valido, true,
    "o limite de um mês é inclusivo no mesmo dia do mês seguinte");
  assert.equal(validarHorarioPix("2026-11-26", "09:00", 60, agora).valido, false);
});


test("segunda, terça, quarta e dezembro mantêm regras anteriores", () => {
  assert.equal(validarHorarioPix("2026-11-02", "13:30", 60).valido, false);
  assert.equal(validarHorarioPix("2026-11-03", "13:30", 60).valido, false);
  assert.equal(validarHorarioPix("2026-11-03", "09:00", 60).valido, false);
  assert.equal(validarHorarioPix("2026-11-04", "13:30", 120).valido, false);
  assert.equal(validarHorarioPix("2026-12-03", "11:00", 60).valido, false);
  assert.equal(obterLimitesAtendimentoSemanal(2).minUltimoInicio, 1080);
  assert.equal(obterLimitesAtendimentoSemanal(3).minFechamento, 1200);
});

test("almoço de meia hora bloqueia sobreposição em todos os dias abertos", () => {
  for (const data of ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]) {
    for (const duracao of [30, 60, 120]) {
      assert.equal(validarHorarioPix(data, "13:30", duracao).valido, false, data + " 13:30 " + duracao);
    }
    assert.equal(validarHorarioPix(data, "14:00", 30).valido, true, data + " 14:00");
  }
  for (const data of ["2026-11-05", "2026-11-06", "2026-11-07"]) {
    assert.equal(validarHorarioPix(data, "12:00", 60).valido, true, data + " 12:00/60");
    assert.equal(validarHorarioPix(data, "12:30", 60).valido, true, data + " 12:30/60");
    assert.equal(validarHorarioPix(data, "13:00", 30).valido, true, data + " 13:00/30");
    assert.equal(validarHorarioPix(data, "12:00", 120).valido, false, data + " 12:00/120");
    assert.equal(validarHorarioPix(data, "13:00", 60).valido, false, data + " 13:00/60");
  }
});

