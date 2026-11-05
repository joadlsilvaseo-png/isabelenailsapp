import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { atendimentosConflitamComBuffer, indisponivelComBuffer, encaixeInteligenteDisponivel,
  BUFFER_ENTRE_ATENDIMENTOS_MINUTOS } from "../src/agendaBuffer.mjs";
import { consultarIntervalosDisponibilidade, intervaloSobrepoeDisponibilidade, listarIniciosEncaixe } from "../../../agendamentoDisponibilidade.js";
import { encontrarConflitoAgendamentoPix } from "../src/pixDocumentoAgendamento.js";
import { validarHorarioPix } from "../src/pixDisponibilidade.js";

test("15 minutos entre serviços: 14h–15h bloqueia 15h e libera 15h30", () => {
  assert.equal(BUFFER_ENTRE_ATENDIMENTOS_MINUTOS, 15);
  const intervalos = [{ inicioMinuto: 840, fimMinuto: 900, tipo: "agendamento" }];
  assert.equal(intervaloSobrepoeDisponibilidade(900, 960, intervalos), true);
  assert.equal(intervaloSobrepoeDisponibilidade(930, 990, intervalos), false);
  assert.equal(intervaloSobrepoeDisponibilidade(780, 840, intervalos), true);
  assert.equal(intervaloSobrepoeDisponibilidade(750, 810, intervalos), false);
  assert.equal(intervaloSobrepoeDisponibilidade(910, 970, intervalos), true);
  assert.equal(intervaloSobrepoeDisponibilidade(920, 980, intervalos), false);
});

test("agenda não muda duração real: todos os serviços têm 15 min antes e depois", () => {
  for (const minutos of [30, 60, 90, 120, 150]) {
    const inicio = 840, fim = inicio + minutos;
    assert.equal(atendimentosConflitamComBuffer(fim, fim + 60, inicio, fim), true);
    assert.equal(atendimentosConflitamComBuffer(fim + 20, fim + 80, inicio, fim), false);
    assert.equal(atendimentosConflitamComBuffer(inicio - 60, inicio, inicio, fim), true);
    assert.equal(atendimentosConflitamComBuffer(inicio - 80, inicio - 20, inicio, fim), false);
  }
});

test("buffer protege agendamentos ativos e ignora cancelados e concluídos", () => {
  const agendamentos = [
    { status: "confirmado", horario: "14:00", duracao: 60 },
    { status: "cancelado", horario: "11:00", duracao: 60 },
  ];
  assert.equal(encontrarConflitoAgendamentoPix(agendamentos, 900, 960), true);
  assert.equal(encontrarConflitoAgendamentoPix(agendamentos, 930, 990), false);
  assert.equal(encontrarConflitoAgendamentoPix(agendamentos, 780, 840), true);
  assert.equal(encontrarConflitoAgendamentoPix(agendamentos, 750, 810), false);
  assert.equal(atendimentosConflitamComBuffer(900, 960, 840, 900, 0), false);
});

test("bloqueios manuais não recebem margem e fechamento não exige buffer extra", () => {
  const bloqueio = [{ inicioMinuto: 900, fimMinuto: 930, tipo: "bloqueio" }];
  assert.equal(indisponivelComBuffer(930, 990, bloqueio), false);
  assert.equal(indisponivelComBuffer(870, 900, bloqueio), false);
  assert.equal(indisponivelComBuffer(900, 930, bloqueio), true);
  assert.equal(indisponivelComBuffer(1200, 1260, []), false);
});

test("API preserva reserva/bloqueio e rejeita tipo inválido", async () => {
  const intervalos = await consultarIntervalosDisponibilidade({
    consultarAgendamentosFirestore: async () => [{ inicioMinuto: 840, fimMinuto: 900, tipo: "agendamento" }],
    consultarReservasPix: async () => [{ inicioMinuto: 900, fimMinuto: 930, tipo: "bloqueio" }],
  });
  assert.equal(intervalos[0].tipo, "agendamento");
  assert.equal(intervalos[1].tipo, "bloqueio");
  assert.equal(intervaloSobrepoeDisponibilidade(930, 990, [intervalos[1]]), false);
  await assert.rejects(consultarIntervalosDisponibilidade({
    consultarAgendamentosFirestore: async () => [],
    consultarReservasPix: async () => [{ inicioMinuto: 0, fimMinuto: 30, tipo: "inválido" }],
  }), /tipo inválido/);
});

test("PIX, isenção, reagendamento pago e Alterar Serviço validam buffer no backend", () => {
  const ler = (nome) => readFileSync(new URL(`../src/${nome}`, import.meta.url), "utf8");
  for (const path of [
    "pixReservas.js", "agendamentosIsencaoPix.js",
    "pixReagendamentoPagoOperacao.js", "agendamentoAlteracaoServico.js",
  ]) {
    assert.match(ler(path), /BUFFER_ENTRE_ATENDIMENTOS_MINUTOS/);
  }
  assert.match(ler("pixAgendaFirestore.js"), /BUFFER_ENTRE_ATENDIMENTOS_MINUTOS/);
  assert.match(ler("pixConfirmacaoFirestore.js"), /reserva\.fim_minuto,\s*0,/);
  assert.match(ler("pixDisponibilidadeApi.js"), /'bloqueio'::text AS tipo/);
});

test("encaixe 17h45–18h45 é seguro entre 17h30 e 19h, sem abrir :15 desnecessários", () => {
  const intervalos = [
    { inicioMinuto: 960, fimMinuto: 1050, tipo: "agendamento" },
    { inicioMinuto: 1140, fimMinuto: 1230, tipo: "reserva" },
  ];
  assert.equal(encaixeInteligenteDisponivel(1065, 1125, intervalos), true);
  assert.equal(encaixeInteligenteDisponivel(1080, 1140, intervalos), false);
  assert.deepEqual(listarIniciosEncaixe({
    abertura: 420, ultimoInicio: 1290, duracao: 60, intervalos,
    validarInicio: () => true, validarInicioPadrao: () => true,
  }), [1065]);
  assert.equal(encaixeInteligenteDisponivel(1065, 1125, [
    ...intervalos, { inicioMinuto: 1080, fimMinuto: 1110, tipo: "bloqueio" },
  ]), false);
  assert.equal(encaixeInteligenteDisponivel(1065, 1125, [intervalos[0]]), false);
  assert.equal(encaixeInteligenteDisponivel(1065, 1125, [intervalos[1]]), false);
  assert.equal(encaixeInteligenteDisponivel(1035, 1095, [
    { inicioMinuto: 960, fimMinuto: 1020, tipo: "agendamento" },
    { inicioMinuto: 1140, fimMinuto: 1230, tipo: "agendamento" },
  ]), false);
});

test("PIX aceita encaixe só após revalidação, sem abrir datas fechadas ou quarta comum", () => {
  const agora = new Date("2026-11-05T12:00:00-03:00");
  const intervalos = [
    { inicioMinuto: 960, fimMinuto: 1050, tipo: "reserva" },
    { inicioMinuto: 1140, fimMinuto: 1230, tipo: "agendamento" },
  ];
  const validar = (data, horario, opcoes) => validarHorarioPix(data, horario, 60, agora, opcoes);
  assert.equal(validar("2026-12-23", "17:45").valido, false);
  assert.equal(validar("2026-12-23", "17:45", { encaixePendente: true }).valido, true);
  assert.equal(validar("2026-12-23", "17:45", { intervalosEncaixe: intervalos }).valido, true);
  assert.equal(validar("2026-12-23", "17:45", { intervalosEncaixe: [intervalos[0]] }).valido, false);
  assert.equal(validar("2026-12-23", "18:15", { intervalosEncaixe: intervalos }).valido, false);
  assert.equal(validar("2026-12-15", "17:45", { intervalosEncaixe: intervalos }).valido, false);
  assert.equal(validar("2026-11-04", "15:15", { encaixePendente: true }).valido, false);
  assert.equal(validar("2026-11-03", "14:15", { encaixePendente: true }).valido, false);
  assert.equal(validar("2026-11-07", "16:45", { encaixePendente: true }).valido, true);
  assert.equal(validar("2026-11-07", "17:15", { encaixePendente: true }).valido, false);
});
