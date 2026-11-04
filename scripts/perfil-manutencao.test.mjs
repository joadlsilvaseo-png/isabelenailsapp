import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ehAplicacaoDeGel,
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

test("usa a última aplicação concluída; ignora manutenção, cancelado e agendado", () => {
  const resultado = encontrarManutencaoSugerida([
    { nomeServico: "Banho de Gel", data: "2026-11-04", status: "concluido" },
    { nomeServico: "Manutenção Banho de Gel", data: "2026-11-19", status: "concluido" },
    { nomeServico: "Aplicação de Gel", data: "2026-11-23", status: "confirmado" },
    { nomeServico: "Alongamento em Fibra de Vidro", data: "2026-10-12", status: "realizado", categoria: "Unhas em Gel" },
    { nomeServico: "Aplicação de Gel", data: "2026-11-12", status: "cancelado_cliente" },
  ]);
  assert.deepEqual(resultado, {
    dataAplicacaoISO: "2026-11-04",
    dataSugeridaISO: "2026-11-25",
    servico: "Banho de Gel",
    dias: 21,
  });
  assert.equal(formatarDataSugestao(resultado.dataSugeridaISO), "25/11/2026");
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
    { nomeServico: "Manutenção Banho de Gel", data: "2026-11-04", status: "concluido" },
  ]), null);
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
  assert.match(html, /Agendar manutenção/);
  assert.match(js, /encontrarManutencaoSugerida\(/);
  assert.match(js, /renderizarSugestaoManutencao\(/);
  assert.match(js, /dados\.data \|\| "--\/--"/);
  assert.match(css, /\.perfil-manutencao\[hidden\]/);
  assert.match(css, /\.perfil-novo-agendamento/);
});
