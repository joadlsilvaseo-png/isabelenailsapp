import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { atendimentosConflitamComBuffer, indisponivelComBuffer, encaixeInteligenteDisponivel, BUFFER_ENTRE_ATENDIMENTOS_MINUTOS } from "../src/agendaBuffer.mjs";
import { intervaloSobrepoeDisponibilidade } from "../../../agendamentoDisponibilidade.js";
import { encontrarConflitoAgendamentoPix } from "../src/pixDocumentoAgendamento.js";
import { validarHorarioPix } from "../src/pixDisponibilidade.js";
import { verificarEncaixeNoBanco } from "../src/pixEncaixes.js";

test("a grade continua de 15 em 15 e horários encostados ficam livres", () => {
  assert.equal(BUFFER_ENTRE_ATENDIMENTOS_MINUTOS, 0);
  const intervalo = [{ inicioMinuto: 840, fimMinuto: 900, tipo: "agendamento" }];
  assert.equal(intervaloSobrepoeDisponibilidade(900, 960, intervalo), false);
  assert.equal(intervaloSobrepoeDisponibilidade(780, 840, intervalo), false);
  assert.equal(intervaloSobrepoeDisponibilidade(885, 945, intervalo), true);
  assert.equal(atendimentosConflitamComBuffer(900, 960, 840, 900), false);
  assert.equal(atendimentosConflitamComBuffer(885, 945, 840, 900), true);
});

test("duração integral do serviço bloqueia sobreposição, sem margem antes/depois", () => {
  for (const minutos of [30, 60, 90, 120, 150]) {
    const inicio = 840, fim = inicio + minutos;
    assert.equal(indisponivelComBuffer(fim, fim + 60, [{ inicioMinuto: inicio, fimMinuto: fim }]), false);
    assert.equal(indisponivelComBuffer(fim - 15, fim + 45, [{ inicioMinuto: inicio, fimMinuto: fim }]), true);
    assert.equal(indisponivelComBuffer(inicio - 60, inicio, [{ inicioMinuto: inicio, fimMinuto: fim }]), false);
  }
  assert.equal(encontrarConflitoAgendamentoPix([
    { status: "confirmado", horario: "14:00", duracao: 60 },
    { status: "cancelado", horario: "11:00", duracao: 60 },
  ], 900, 960), false);
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
  assert.equal(await verificarEncaixeNoBanco(params), true);
  itens.push({ inicio_minuto: 1080, fim_minuto: 1110, tipo: "bloqueio" });
  assert.equal(await verificarEncaixeNoBanco(params), false);
  const ler = (nome) => readFileSync(new URL(`../src/${nome}`, import.meta.url), "utf8");
  for (const path of ["pixReservas.js", "agendamentosIsencaoPix.js", "pixReagendamentoPagoOperacao.js", "agendamentoAlteracaoServico.js"]) {
    assert.match(ler(path), /BUFFER_ENTRE_ATENDIMENTOS_MINUTOS/);
  }
  assert.match(ler("pixConfirmacaoFirestore.js"), /reserva\.fim_minuto,\s*0,/);
});
