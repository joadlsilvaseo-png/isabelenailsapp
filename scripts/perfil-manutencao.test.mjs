import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ehAplicacaoDeGel,
  ehManutencaoDeGel,
  ehRemocaoDeGel,
  ehProcedimentoCicloGel,
  encontrarManutencaoSugerida,
  formatarDataSugestao,
} from "../perfilManutencao.mjs";

test("reconhece apenas aplicações de gel, inclusive alongamento e fibra da categoria", () => {
  const elegiveis = [
    { nome: "Aplicação de Gel", categoria: "Unhas em Gel" },
    { nome: "Banho de Gel", categoria: "Unhas em Gel" },
    { nome: "Alongamento em Fibra de Vidro", categoria: "Unhas em Gel" },
    { nome: "Aplicação de Alongamento", categoria: "unhas-em-gel" },
  ];
  for (const item of elegiveis) assert.equal(ehAplicacaoDeGel(item), true, item.nome);

  const ignorados = [
    { nome: "Manutenção Banho de Gel", categoria: "Unhas em Gel" },
    { nome: "Remoção de Alongamento", categoria: "Unhas em Gel" },
    { nome: "Esmaltação em Gel", categoria: "Manicure" },
    { nome: "Manicure Simples", categoria: "Manicure" },
    { nome: "Pedicure em Gel", categoria: "Pedicure" },
    { nome: "Aplicação de Alongamento" },
    { nome: "Blindagem", categoria: "Unhas em Gel" },
  ];
  for (const item of ignorados) assert.equal(ehAplicacaoDeGel(item), false, item.nome);
});

test("reconhece manutenção em gel/fibra e exclui serviços que não reiniciam o ciclo", () => {
  const elegiveis = [
    { nome: "Manutenção Banho de Gel", categoria: "Unhas em Gel" },
    { nome: "Manutenção de Banho de Gel", categoria: "Unhas em Gel" },
    { nome: "Manutenção Alongamento em Fibra", categoria: "Unhas em Gel" },
    { nome: "Manutenção em Gel", categoria: "Unhas em Gel" },
    { nome: "MANUTENÇÃO DE ALONGAMENTO", categoria: "Unhas em Gel" },
    { nome: "Manutenção", categoria: "unhas-em-gel" },
    { nome: "Retoque de Fibra de Vidro" },
  ];
  for (const item of elegiveis) {
    assert.equal(ehManutencaoDeGel(item), true, item.nome);
    assert.equal(ehProcedimentoCicloGel(item), true, item.nome);
    assert.equal(ehAplicacaoDeGel(item), false, item.nome);
  }
  for (const item of [
    { nome: "Manutenção de cílios", categoria: "Cílios" },
    { nome: "Manutenção de alongamento de cílios", categoria: "Cílios" },
    { nome: "Manutenção de cabelo", categoria: "Cabeleireiro" },
    { nome: "Manutenção pedicure em gel", categoria: "Pedicure" },
    { nome: "Manicure em gel", categoria: "Manicure" },
    { nome: "Esmaltação em gel", categoria: "Unhas em Gel" },
    { nome: "Remoção de Alongamento", categoria: "Unhas em Gel" },
    { nome: "Manutenção e Remoção de Alongamento", categoria: "Unhas em Gel" },
  ]) assert.equal(ehProcedimentoCicloGel(item), false, item.nome);
  assert.equal(ehRemocaoDeGel({ nome: "Remoção de Alongamento", categoria: "Unhas em Gel" }), true);
});

test("usa o último procedimento concluído, aplicação ou manutenção", () => {
  const resultado = encontrarManutencaoSugerida([
    { nomeServico: "Banho de Gel", data: "2026-11-04", status: "concluido" },
    { nomeServico: "Manutenção Banho de Gel", data: "2026-11-19", status: "concluido" },
    { nomeServico: "Aplicação de Gel", data: "2026-11-23", status: "confirmado" },
    { nomeServico: "Alongamento em Fibra de Vidro", data: "2026-10-12", status: "realizado", categoria: "Unhas em Gel" },
    { nomeServico: "Aplicação de Gel", data: "2026-11-12", status: "cancelado_cliente" },
  ]);
  assert.deepEqual(resultado, {
    dataUltimoAtendimentoISO: "2026-11-19",
    dataSugeridaISO: "2026-12-10",
    servico: "Manutenção Banho de Gel",
    tipoProcedimento: "manutencao",
    dias: 21,
  });
  assert.equal(formatarDataSugestao(resultado.dataSugeridaISO), "10/12/2026");
});

test("somar 21 dias funciona na virada de mês e ano, incluindo ano bissexto", () => {
  const dados = [
    ["2026-12-20", "2027-01-10"],
    ["2028-02-15", "2028-03-07"],
    ["2026-01-31", "2026-02-21"],
  ];
  for (const [data, esperado] of dados) {
    const r = encontrarManutencaoSugerida([
      { nomeServico: "Banho de Gel", data, status: "concluido" },
    ]);
    assert.equal(r?.dataSugeridaISO, esperado);
  }
});

test("não recomenda manutenção sem procedimento elegível e data válida", () => {
  assert.equal(encontrarManutencaoSugerida([]), null);
  assert.equal(encontrarManutencaoSugerida([
    { nomeServico: "Banho de Gel", data: "2026-02-30", status: "concluido" },
    { nomeServico: "Manicure em Gel", data: "2026-11-04", status: "concluido" },
  ]), null);
});

test("manutenção consecutiva reinicia 21 dias; remoção concluída encerra o ciclo", () => {
  const base = [
    { nomeServico: "Aplicação de Gel", categoria: "Unhas em Gel", data: "2026-10-01", status: "concluido" },
    { nomeServico: "Manutenção de Banho de Gel", categoria: "Unhas em Gel", data: "2026-10-22", status: "realizado" },
    { nomeServico: "Manutenção de Alongamento", categoria: "Unhas em Gel", data: "2026-11-12", status: "concluido" },
  ];
  const sugestao = encontrarManutencaoSugerida([...base,
    { nomeServico: "Manicure Simples", data: "2026-11-14", status: "realizado" },
    { nomeServico: "Manutenção de Fibra", data: "2026-11-20", status: "confirmado" },
  ]);
  assert.equal(sugestao.dataUltimoAtendimentoISO, "2026-11-12");
  assert.equal(sugestao.dataSugeridaISO, "2026-12-03");
  assert.equal(sugestao.tipoProcedimento, "manutencao");
  assert.equal(encontrarManutencaoSugerida([...base,
    { nomeServico: "Remoção de Alongamento", categoria: "Unhas em Gel", data: "2026-11-16", status: "concluido" },
  ]), null);
  assert.equal(encontrarManutencaoSugerida([
    { nomeServico: "Manutenção em Gel", data: "2026-11-20", status: "concluido" },
  ])?.dataSugeridaISO, "2026-12-11");
});

test("integra o card no perfil sem alterar o formato das datas existentes", async () => {
  const html = await readFile(new URL("../meu-perfil.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../meu-perfil.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../meu-perfil.css", import.meta.url), "utf8");

  const summaryPos = html.indexOf('class="perfil-summary"');
  const maintenancePos = html.indexOf('id="perfil-manutencao"');
  const attendancesPos = html.indexOf('id="meus-agendamentos"');
  assert.ok(summaryPos >= 0 && maintenancePos > summaryPos && attendancesPos > maintenancePos);
  assert.match(html, /href="principal\.html#services-title"[^>]+class="perfil-novo-agendamento"/);
  assert.match(html, /id="perfil-manutencao-data"/);
  assert.match(html, /id="perfil-manutencao-ultimo"/);
  assert.match(html, /id="perfil-manutencao-tipo"/);
  assert.match(js, /ehProcedimentoCicloGel/);
  assert.match(html, /Agendar manutenção/);
  assert.match(js, /encontrarManutencaoSugerida\(/);
  assert.match(js, /renderizarSugestaoManutencao\(/);
  assert.match(js, /dados\.data \|\| "--\/--"/);
  assert.match(css, /\.perfil-manutencao\[hidden\]/);
  assert.match(css, /\.perfil-novo-agendamento/);
});

test("Meu Perfil também oferece avaliação no Google, visível sem atendimento concluído", async () => {
  const html = await readFile(new URL("../meu-perfil.html", import.meta.url), "utf8");
  const inicio = html.indexOf('id="meus-agendamentos"');
  const avaliacao = html.indexOf('class="avaliacao-google"', inicio);
  const rodape = html.indexOf('class="perfil-footer"', inicio);
  assert.ok(inicio >= 0 && avaliacao > inicio && rodape > avaliacao);
  const trecho = html.slice(avaliacao, rodape);
  assert.match(trecho, /href="https:\/\/g\.page\/r\/CVxYoLzta8eSECE\/review"/);
  assert.match(trecho, /target="_blank" rel="noopener noreferrer"/);
  assert.match(trecho, /Avaliar no Google/);
  assert.doesNotMatch(trecho, /<section[^>]*hidden/);
  assert.match(html, /avaliacoes-google\.css\?v=1/);
});
