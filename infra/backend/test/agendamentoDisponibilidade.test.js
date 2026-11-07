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

test("reserva de duas horas protege o início exato e libera o próximo slot", () => {
  const reservas = [{ inicioMinuto: 810, fimMinuto: 930 }];
  assert.equal(intervaloSobrepoeDisponibilidade(780, 840, reservas), true);
  assert.equal(intervaloSobrepoeDisponibilidade(900, 960, reservas), true);
  assert.equal(intervaloSobrepoeDisponibilidade(930, 990, reservas), true);
  assert.equal(intervaloSobrepoeDisponibilidade(960, 1020, reservas), false);
});

test("quarta: horários adicionais respeitam agendamento anterior, duração e próximo início", () => {
  // Manhã: serviço das 09:00 às 11:30 impede outro serviço que comece às 10h,
  // 10h30 ou 11h; se terminar às 10h, libera exatamente 10h.
  const manhaOcupada = [{ inicioMinuto: 540, fimMinuto: 690 }];
  for (const [inicio, fim] of [[600, 660], [630, 720], [660, 720]]) {
    assert.equal(intervaloSobrepoeDisponibilidade(inicio, fim, manhaOcupada), true);
  }
  assert.equal(
    intervaloSobrepoeDisponibilidade(600, 690, [{ inicioMinuto: 540, fimMinuto: 600 }]),
    true,
  );

  // Tarde: quem terminou às 15:00 não impede novo início exatamente às 15h;
  // serviço iniciado às 14h que ultrapassa 15h continua bloqueando.
  assert.equal(
    intervaloSobrepoeDisponibilidade(900, 990, [{ inicioMinuto: 840, fimMinuto: 900 }]),
    true,
  );
  assert.equal(
    intervaloSobrepoeDisponibilidade(900, 990, [{ inicioMinuto: 840, fimMinuto: 930 }]),
    true,
  );
  // Reservas PIX e bloqueios administrativos usam a mesma verificação.
  assert.equal(
    intervaloSobrepoeDisponibilidade(900, 960, [{ inicioMinuto: 930, fimMinuto: 960 }]),
    true,
  );
  // A API rejeita durações não autorizadas mesmo que o intervalo esteja livre.
  const agora = new Date("2026-10-22T12:00:00Z");
  assert.equal(validarHorarioPix("2026-11-11", "15:00", 60, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-11", "15:00", 90, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-11", "15:00", 120, agora).valido, true);
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

test("quinta encerra atendimentos às 21h e inicia no máximo às 20h30", () => {
  const limites = obterLimitesAtendimentoSemanal(4);
  assert.deepEqual(limites, {
    minAbertura: 660,
    minUltimoInicio: 1245,
    minFechamento: 1260,
  });
  for (const [horario, duracao] of [
    ["11:00", 120], ["12:00", 60], ["12:00", 120], ["12:30", 60],
    ["13:00", 30], ["13:00", 60], ["13:30", 30], ["13:30", 90],
    ["14:00", 120], ["17:30", 150], ["18:00", 120], ["18:30", 120],
    ["19:00", 120], ["19:30", 90], ["20:00", 60], ["20:30", 30],
  ]) conferir("2026-11-05", horario, duracao, true);

  for (const [horario, duracao] of [
    ["09:00", 60], ["10:30", 60], ["19:00", 150],
    ["19:30", 120], ["20:00", 90], ["20:30", 60],
    ["21:00", 30], ["21:30", 30],
  ]) conferir("2026-11-05", horario, duracao, false);
});

test("sexta encerra atendimentos às 21h e inicia no máximo às 20h30", () => {
  const limites = obterLimitesAtendimentoSemanal(5);
  assert.deepEqual(limites, {
    minAbertura: 540,
    minUltimoInicio: 1245,
    minFechamento: 1260,
  });
  for (const [horario, duracao] of [
    ["09:00", 120], ["11:30", 60], ["12:00", 60], ["12:00", 120],
    ["12:30", 60], ["13:00", 30], ["13:00", 60],
    ["13:30", 30], ["13:30", 90], ["14:00", 120],
    ["17:30", 150], ["18:00", 120], ["18:30", 120],
    ["19:00", 120], ["19:30", 90], ["20:00", 60], ["20:30", 30],
  ]) conferir("2026-11-06", horario, duracao, true);

  for (const [horario, duracao] of [
    ["08:30", 60], ["19:00", 150], ["19:30", 120],
    ["20:00", 90], ["20:30", 60], ["21:00", 30],
    ["21:30", 30],
  ]) conferir("2026-11-06", horario, duracao, false);
});

test("sábado mantém encerramento às 18h com exceção às 16h para 150 min", () => {
  const limites = obterLimitesAtendimentoSemanal(6);
  assert.deepEqual(limites, {
    minAbertura: 540,
    minUltimoInicio: 1065,
    minFechamento: 1110,
  });
  for (const [horario, duracao] of [
    ["09:00", 120], ["12:00", 120], ["13:00", 60],
    ["14:00", 120], ["15:00", 90], ["15:30", 90],
    ["16:00", 30], ["16:00", 60], ["16:00", 90], ["16:00", 120],
    ["16:00", 150], ["16:30", 90], ["17:00", 60],
    ["17:15", 30], ["17:30", 30], ["17:45", 15],
  ]) conferir("2026-11-07", horario, duracao, true);
  for (const [horario, duracao] of [
    ["16:00", 151], ["16:00", 180], ["14:00", 270],
    ["14:30", 240], ["16:30", 120], ["17:00", 90],
    ["17:30", 60], ["18:00", 15], ["23:00", 120],
  ]) conferir("2026-11-07", horario, duracao, false);
});

test("não existe pausa fixa: quinta, sexta e sábado aceitam atendimentos atravessando 13h30", () => {
  for (const data of ["2026-11-05", "2026-11-06", "2026-11-07"]) {
    for (const [horario, duracao] of [
      ["12:00", 120], ["12:30", 90], ["13:00", 60], ["13:30", 30], ["13:30", 60],
      ["13:30", 90], ["14:00", 60],
    ]) {
      conferir(data, horario, duracao, true);
    }
  }

  // Terça e quarta preservam janelas especiais: não são bloqueios de almoço.
  for (const data of ["2026-11-03", "2026-11-04"]) {
    conferir(data, "13:30", 60, false);
    conferir(data, "14:00", 60, true);
  }
});

test("bloqueio administrativo no almoço prevalece mesmo sem pausa automática", () => {
  const manual = [{ inicioMinuto: 810, fimMinuto: 840, tipo: "bloqueio" }]; // 13h30–14h
  assert.equal(intervaloSobrepoeDisponibilidade(780, 840, manual), true); // 13h–14h
  assert.equal(intervaloSobrepoeDisponibilidade(780, 900, manual), true); // 13h–15h
  assert.equal(intervaloSobrepoeDisponibilidade(840, 900, manual), false); // 14h em diante
  assert.equal(validarHorarioPix("2026-11-05", "13:30", 60, AGORA).valido, true);
});
