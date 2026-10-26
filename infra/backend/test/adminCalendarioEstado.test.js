import test from "node:test";
import assert from "node:assert/strict";
import {
  alternarIntervalo,
  criarPayloadLote,
  encerrarOperacaoCalendario,
  formatarErroCalendario,
  formatarFalhaDeRede,
  iniciarOperacaoCalendario,
  obterDataAtiva,
  removerIntervalos,
  resumirSelecoes,
} from "../../../admin-calendario-state.mjs";
import { obterMesesGerenciaveis } from "../src/agendamentoRegras.mjs";

test("seletor lista mês atual e dois seguintes, incluindo a virada do ano", () => {
  assert.deepEqual(
    obterMesesGerenciaveis(new Date("2026-10-26T15:00:00Z")).map(({ chave }) => chave),
    ["2026-10", "2026-11", "2026-12"],
  );
  assert.deepEqual(
    obterMesesGerenciaveis(new Date("2026-12-31T15:00:00Z")).map(({ chave }) => chave),
    ["2026-12", "2027-01", "2027-02"],
  );
});

test("navegação entre meses restaura o dia escolhido e preserva seleções por data", () => {
  const selecoes = new Map();
  alternarIntervalo(selecoes, "2026-11-05", 840);
  alternarIntervalo(selecoes, "2026-12-03", 840);
  assert.equal(obterDataAtiva(["2026-12-03", "2026-12-04"], "2026-12-03"), "2026-12-03");
  assert.equal(obterDataAtiva(["2027-01-05"], "2026-12-03"), "2027-01-05");
  assert.deepEqual([...selecoes.keys()], ["2026-11-05", "2026-12-03"]);
});

test("quatro datas de novembro e dezembro viram um único lote com intervalos agrupados", () => {
  const selecoes = new Map();
  for (const data of ["2026-11-05", "2026-11-12", "2026-11-19", "2026-12-03"]) {
    alternarIntervalo(selecoes, data, 840);
    alternarIntervalo(selecoes, data, 870);
    alternarIntervalo(selecoes, data, 900);
    alternarIntervalo(selecoes, data, 930);
  }
  const resumo = resumirSelecoes(selecoes);
  const lote = criarPayloadLote(selecoes, "fechar");
  assert.equal(resumo.quantidadeDatas, 4);
  assert.equal(resumo.quantidadeIntervalos, 16);
  assert.deepEqual(lote.datas.map(({ data, horas }) => [data, horas]), [
    ["2026-11-05", [840, 870, 900, 930]],
    ["2026-11-12", [840, 870, 900, 930]],
    ["2026-11-19", [840, 870, 900, 930]],
    ["2026-12-03", [840, 870, 900, 930]],
  ]);
  assert.equal(resumo.datas[0].grupos[0].fim, 960);
});

test("reabertura mantém cada data separada no payload", () => {
  const selecoes = new Map([
    ["2026-11-05", new Set([900, 930])],
    ["2026-12-03", new Set([840])],
  ]);
  assert.deepEqual(criarPayloadLote(selecoes, "reabrir"), {
    acao: "reabrir",
    datas: [
      { data: "2026-11-05", horas: [900, 930] },
      { data: "2026-12-03", horas: [840] },
    ],
  });
});

test("remover um grupo ou uma data atualiza o resumo sem duplicar intervalos", () => {
  const selecoes = new Map();
  alternarIntervalo(selecoes, "2026-11-05", 840);
  alternarIntervalo(selecoes, "2026-11-05", 870);
  alternarIntervalo(selecoes, "2026-11-05", 870);
  assert.deepEqual([...selecoes.get("2026-11-05")], [840]);
  removerIntervalos(selecoes, "2026-11-05", [840]);
  assert.equal(resumirSelecoes(selecoes).quantidadeDatas, 0);
});

test("bloqueia submissões duplicadas e reabilita após concluir", () => {
  const estado = { carregando: false, salvando: false, erroConsulta: false };
  assert.equal(iniciarOperacaoCalendario(estado), true);
  assert.equal(iniciarOperacaoCalendario(estado), false);
  encerrarOperacaoCalendario(estado);
  assert.equal(iniciarOperacaoCalendario(estado), true);
  encerrarOperacaoCalendario(estado);
  estado.erroConsulta = true;
  assert.equal(iniciarOperacaoCalendario(estado), false);
});

test("erros HTTP e de rede preservam o motivo e permitem orientar nova tentativa", () => {
  assert.match(formatarErroCalendario(409, { erro: "Conflito em 03/12/2026, 14:30–15:00" }), /03\/12\/2026/);
  assert.match(formatarErroCalendario(403), /Acesso administrativo negado/);
  assert.match(formatarErroCalendario(503), /HTTP 503/);
  assert.match(formatarFalhaDeRede(new TypeError("offline")), /API do calendário/);
  assert.match(formatarFalhaDeRede(Object.assign(new Error("timeout"), { name: "TimeoutError" })), /tente novamente/);
});
