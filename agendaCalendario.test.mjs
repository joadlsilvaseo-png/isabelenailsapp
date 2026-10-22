import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ler = (arquivo) => readFile(new URL(arquivo, import.meta.url), "utf8");

test("o calendário oferece navegação mensal e não mantém o limite antigo de oito datas", async () => {
  const html = await ler("./agendamento.html");
  const js = await ler("./agendamento.js");
  const css = await ler("./agendamento.css");
  assert.match(html, /id="calendar-previous-month"/);
  assert.match(html, /id="calendar-next-month"/);
  assert.match(js, /calcularJanelaMensal/);
  assert.match(js, /estaNaJanelaMensal/);
  assert.doesNotMatch(js, /dias\.length\s*<\s*8/);
  assert.match(css, /grid-template-columns:\s*repeat\(7/);
});

test("a interface e a reserva PIX compartilham a janela mensal, preservando os bloqueios de novembro e dezembro", async () => {
  const js = await ler("./agendamento.js");
  const api = await ler("./infra/backend/src/pixDisponibilidadeApi.js");
  const reserva = await ler("./infra/backend/src/pixDisponibilidade.js");
  assert.match(js, /data < "2026-11-01"/);
  assert.match(js, /DATAS_DEZEMBRO_LIBERADAS/);
  assert.match(api, /estaNaJanelaMensal\(data/);
  assert.match(reserva, /estaNaJanelaMensal\(dataIso/);
  assert.match(reserva, /ano === 2026 && mes === 12/);
});

test("a agenda de quarta renderiza somente os inícios fixos e o backend compartilha a mesma regra", async () => {
  const js = await ler("./agendamento.js");
  const regras = await ler("./agendamentoDisponibilidade.js");
  const pix = await ler("./infra/backend/src/pixDisponibilidade.js");
  const reservas = await ler("./infra/backend/src/pixReservas.js");
  assert.match(js, /obterIniciosEspeciaisSemanais\(diaSemanaSelecionado\)/);
  assert.match(js, /Início às 09:00/);
  assert.match(js, /Início às 14:00/);
  assert.match(js, /Não há horários disponíveis nesta data/);
  assert.match(regras, /diaSemana === 3 \? \[540, 840\] : null/);
  assert.match(regras, /inicioMinuto === 540.*fimMinuto <= 750/s);
  assert.match(regras, /inicioMinuto === 840.*fimMinuto <= 1050/s);
  assert.match(pix, /validarHorarioEspecialSemanal\(diaSemana, inicio, duracao\)/);
  assert.match(reservas, /validarHorarioPix\(data, horario, duracao\)/);
  assert.match(reservas, /if \(!periodo\.valido\)\s*\{\s*throw new ErroReserva\(400, periodo\.motivo\)/);
});

