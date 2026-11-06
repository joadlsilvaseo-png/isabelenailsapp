import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { atendimentosConflitamComBuffer, indisponivelComBuffer, encaixeInteligenteDisponivel,
  BUFFER_ENTRE_ATENDIMENTOS_MINUTOS } from "../src/agendaBuffer.mjs";
import { consultarIntervalosDisponibilidade, intervaloSobrepoeDisponibilidade, listarIniciosEncaixe } from "../../../agendamentoDisponibilidade.js";
import { encontrarConflitoAgendamentoPix } from "../src/pixDocumentoAgendamento.js";
import { validarHorarioPix } from "../src/pixDisponibilidade.js";
import { verificarEncaixeNoBanco } from "../src/pixEncaixes.js";

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

test("grade de 15min aceita :00/:15/:30/:45 sem depender de duas reservas", () => {
  const agora = new Date("2026-11-05T12:00:00-03:00");
  for (const horario of ["17:00", "17:15", "17:30", "17:45"]) {
    assert.equal(validarHorarioPix("2026-12-23", horario, 60, agora).valido, true, horario);
  }
  assert.equal(validarHorarioPix("2026-12-23", "17:10", 60, agora).valido, false);
  assert.equal(validarHorarioPix("2026-12-15", "17:45", 60, agora).valido, false);
  // Quarta comum recebe 15min dentro das janelas já autorizadas.
  assert.equal(validarHorarioPix("2026-11-11", "15:15", 60, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-11", "12:15", 60, agora).valido, false);
  assert.equal(validarHorarioPix("2026-11-07", "17:30", 30, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-07", "17:45", 30, agora).valido, false);
  const previo = [{ inicioMinuto: 960, fimMinuto: 1020, tipo: "reserva" }];
  assert.equal(validarHorarioPix("2026-12-23", "17:15", 60, agora, {
    intervalosEncaixe: previo,
  }).valido, true);
  assert.equal(validarHorarioPix("2026-12-23", "17:00", 60, agora, {
    intervalosEncaixe: previo,
  }).valido, false);
});

test("servidor valida disponibilidade real :15 sob lock com uma ou duas bordas", async () => {
  const agora = new Date("2026-11-05T12:00:00-03:00");
  const items = [
    { inicio_minuto: 960, fim_minuto: 1050, tipo: "reserva" },
    { inicio_minuto: 1140, fim_minuto: 1230, tipo: "reserva" },
  ];
  const consultaPg = { query: async (_sql, parametros) => {
    assert.equal(parametros[0], "2026-12-23");
    return { rows: items };
  } };
  const banco = { collection: () => ({ where: () => ({
    get: async () => ({ docs: [] }),
  }) }) };
  const params = { conexao: consultaPg, db: banco, data: "2026-12-23",
    inicio: 1065, fim: 1125, agora };
  assert.equal(await verificarEncaixeNoBanco(params), true);
  assert.equal(await verificarEncaixeNoBanco({ ...params, fim: 1140 }), false);
  items.splice(1, 1);
  assert.equal(await verificarEncaixeNoBanco(params), true); // Só borda anterior
  items.splice(0, 1);
  assert.equal(await verificarEncaixeNoBanco(params), true); // Sem borda
  items.push({ inicio_minuto: 1080, fim_minuto: 1110, tipo: "bloqueio" });
  assert.equal(await verificarEncaixeNoBanco(params), false); // Bloqueio manual
});
