import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { atendimentosConflitamComBuffer, indisponivelComBuffer, encaixeInteligenteDisponivel, BUFFER_ENTRE_ATENDIMENTOS_MINUTOS } from "../src/agendaBuffer.mjs";
import { intervaloSobrepoeDisponibilidade } from "../../../agendamentoDisponibilidade.js";
import { encontrarConflitoAgendamentoPix } from "../src/pixDocumentoAgendamento.js";
import { validarHorarioPix } from "../src/pixDisponibilidade.js";
import { verificarEncaixeNoBanco } from "../src/pixEncaixes.js";

test("a grade continua de 15 em 15 e protege início no término", () => {
  assert.equal(BUFFER_ENTRE_ATENDIMENTOS_MINUTOS, 0);
  const intervalo = [{ inicioMinuto: 840, fimMinuto: 900, tipo: "agendamento" }];
  assert.equal(intervaloSobrepoeDisponibilidade(900, 960, intervalo), true);
  assert.equal(intervaloSobrepoeDisponibilidade(780, 840, intervalo), false);
  assert.equal(intervaloSobrepoeDisponibilidade(885, 945, intervalo), true);
  assert.equal(atendimentosConflitamComBuffer(900, 960, 840, 900), false);
  assert.equal(atendimentosConflitamComBuffer(885, 945, 840, 900), true);
});

test("duração integral protege o próximo início sem buffer nas duas pontas", () => {
  for (const minutos of [30, 60, 90, 120, 150]) {
    const inicio = 840, fim = inicio + minutos;
    assert.equal(indisponivelComBuffer(fim, fim + 60, [{ inicioMinuto: inicio, fimMinuto: fim }]), true);
    assert.equal(indisponivelComBuffer(fim + 15, fim + 75, [{ inicioMinuto: inicio, fimMinuto: fim }]), false);
    assert.equal(indisponivelComBuffer(fim - 15, fim + 45, [{ inicioMinuto: inicio, fimMinuto: fim }]), true);
    assert.equal(indisponivelComBuffer(inicio - 60, inicio, [{ inicioMinuto: inicio, fimMinuto: fim }]), false);
  }
  assert.equal(encontrarConflitoAgendamentoPix([
    { status: "confirmado", horario: "14:00", duracao: 60 },
    { status: "cancelado", horario: "11:00", duracao: 60 },
  ], 900, 960), true);
  assert.equal(encontrarConflitoAgendamentoPix([
    { status: "confirmado", horario: "14:00", duracao: 60 },
  ], 885, 945), true);
});

test("bloqueios e reservas continuam impedindo somente sobreposições reais", () => {
  const bloqueio = [{ inicioMinuto: 900, fimMinuto: 930, tipo: "bloqueio" }];
  assert.equal(indisponivelComBuffer(930, 990, bloqueio), false);
  assert.equal(indisponivelComBuffer(870, 900, bloqueio), false);
  assert.equal(indisponivelComBuffer(915, 945, bloqueio), true);
  assert.equal(encaixeInteligenteDisponivel(885, 945, bloqueio), false);
  assert.equal(encaixeInteligenteDisponivel(930, 990, bloqueio), true);
});

test("regras de horário continuam aceitando qualquer início válido da grade", () => {
  const agora = new Date("2026-11-05T12:00:00-03:00");
  assert.equal(validarHorarioPix("2026-11-10", "14:15", 60, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-10", "14:45", 60, agora).valido, true);
  assert.equal(validarHorarioPix("2026-11-10", "14:10", 60, agora).valido, false);
  assert.equal(validarHorarioPix("2026-12-15", "17:45", 30, agora).valido, false);
  assert.equal(validarHorarioPix("2026-11-07", "17:15", 30, agora).valido, true);
});

test("o backend mantém a validação sob lock e todas as fontes de ocupação", async () => {
  const itens = [{ inicio_minuto: 960, fim_minuto: 1050, tipo: "reserva" }];
  const conexao = { query: async () => ({ rows: itens }) };
  const db = { collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }) };
  const params = { conexao, db, data: "2026-12-23", inicio: 1050, fim: 1110 };
  assert.equal(await verificarEncaixeNoBanco(params), false);
  assert.equal(await verificarEncaixeNoBanco({ ...params, inicio: 1065, fim: 1125 }), true);
  itens.push({ inicio_minuto: 1080, fim_minuto: 1110, tipo: "bloqueio" });
  assert.equal(await verificarEncaixeNoBanco(params), false);
  const ler = (nome) => readFileSync(new URL(`../src/${nome}`, import.meta.url), "utf8");
  for (const path of ["pixReservas.js", "agendamentosIsencaoPix.js", "pixReagendamentoPagoOperacao.js", "agendamentoAlteracaoServico.js"]) {
    assert.match(ler(path), /BUFFER_ENTRE_ATENDIMENTOS_MINUTOS/);
  }
  assert.match(ler("pixConfirmacaoFirestore.js"), /reserva\.fim_minuto,\s*0,/);
});

test("direcional: libera 15 min depois e permite sequência da mesma cliente", () => {
  const anterior = { inicioMinuto: 840, fimMinuto: 900, tipo: "agendamento" };
  assert.equal(indisponivelComBuffer(900, 930, [anterior]), true);
  assert.equal(indisponivelComBuffer(915, 945, [anterior]), false);
  assert.equal(indisponivelComBuffer(810, 840, [anterior]), false);
  assert.equal(indisponivelComBuffer(900, 930, [{ ...anterior, sequencialMesmaCliente: true }]), false);
  assert.equal(indisponivelComBuffer(885, 915, [{ ...anterior, sequencialMesmaCliente: true }]), true);
  assert.equal(indisponivelComBuffer(900, 930, [{ ...anterior, tipo: "bloqueio" }]), false);
  assert.equal(indisponivelComBuffer(915, 945, [{ ...anterior, fimMinuto: 905 }]), false);
  assert.equal(encontrarConflitoAgendamentoPix([
    { status: "reagendado", clienteId: "cliente-a", horario: "14:00", duracao: 60 },
  ], 900, 930, undefined, "cliente-a"), false);
});

test("PIX previamente reservado e pago pode confirmar sem proteção retroativa", () => {
  const existente = [{ status: "confirmado", horario: "14:00", duracao: 60 }];
  assert.equal(encontrarConflitoAgendamentoPix(existente, 900, 960), true);
  assert.equal(encontrarConflitoAgendamentoPix(existente, 900, 960, 0, null,
    { ignorarProtecaoInicio: true }), false);
  assert.equal(encontrarConflitoAgendamentoPix(existente, 885, 945, 0, null,
    { ignorarProtecaoInicio: true }), true);
});
