import test from "node:test";
import assert from "node:assert/strict";
import {
  consultarIntervalosDisponibilidade,
  intervaloSobrepoeDisponibilidade,
} from "../../../agendamentoDisponibilidade.js";

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
