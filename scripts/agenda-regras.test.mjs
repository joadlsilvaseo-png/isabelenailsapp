import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { adicionarMesCalendario, obterJanelaAgendamento, obterMesesGerenciaveis, validarDataGerenciavel, validarDataNaJanela, validarHorarioEspecial, listarSlotsGerenciaveis } from "../infra/backend/src/agendamentoRegras.mjs";

const dataDoDia = (diaSemana, referencia = "2026-11-01") => {
  const data = new Date(`${referencia}T12:00:00Z`);
  while (data.getUTCDay() !== diaSemana) data.setUTCDate(data.getUTCDate() + 1);
  return data.toISOString().slice(0, 10);
};

test("janela móvel inicia na abertura de novembro e avança por um mês de calendário", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.deepEqual(obterJanelaAgendamento(now), { inicio: "2026-11-01", fim: "2026-11-22" });
  assert.equal(validarDataNaJanela("2026-11-21", now).valido, true);
  assert.equal(validarDataNaJanela("2026-11-23", now).valido, false);
});

test("cálculo mensal trata final de mês, fevereiro bissexto e virada do ano", () => {
  assert.equal(adicionarMesCalendario("2027-01-31"), "2027-02-28");
  assert.equal(adicionarMesCalendario("2028-01-31"), "2028-02-29");
  assert.equal(adicionarMesCalendario("2026-12-31"), "2027-01-31");
});

test("abertura de dezembro amplia a janela até 31/12, preservando datas fechadas", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  assert.deepEqual(obterJanelaAgendamento(now), { inicio: "2026-11-15", fim: "2026-12-31" });
  assert.equal(validarDataNaJanela("2026-12-10", now).valido, true);
  assert.equal(validarDataNaJanela("2026-12-14", now).valido, true);
  assert.equal(validarDataNaJanela("2026-12-15", now).valido, false);
  assert.equal(validarDataNaJanela("2026-12-31", now).valido, false);
});

test("admin pode gerenciar mês atual e dois seguintes sem abrir dezembro às clientes", () => {
  const agora = new Date("2026-10-26T15:00:00Z");
  assert.deepEqual(obterMesesGerenciaveis(agora).map(({ chave }) => chave), [
    "2026-10", "2026-11", "2026-12",
  ]);
  assert.equal(validarDataGerenciavel("2026-10-25", agora).valido, false);
  assert.equal(validarDataGerenciavel("2026-10-26", agora).valido, true);
  assert.equal(validarDataGerenciavel("2026-12-31", agora).valido, true);
  assert.equal(validarDataGerenciavel("2027-01-01", agora).valido, false);
  assert.equal(validarDataNaJanela("2026-12-03", agora).valido, false);
  assert.ok(listarSlotsGerenciaveis("2026-12-03", agora).includes(660));
});

test("janela administrativa cruza dezembro e janeiro sem ano fixo", () => {
  const meses = obterMesesGerenciaveis(new Date("2026-12-31T15:00:00Z"));
  assert.deepEqual(meses.map(({ chave, inicio, fim }) => ({ chave, inicio, fim })), [
    { chave: "2026-12", inicio: "2026-12-31", fim: "2026-12-31" },
    { chave: "2027-01", inicio: "2027-01-01", fim: "2027-01-31" },
    { chave: "2027-02", inicio: "2027-02-01", fim: "2027-02-28" },
  ]);
  assert.equal(validarDataGerenciavel("2027-01-01", new Date("2026-12-31T15:00:00Z")).valido, true);
});

test("terça aceita inícios a cada 15 min dentro da janela 14h–17h30", () => {
  const data = dataDoDia(2);
  for (const h of ["14:00", "14:15", "15:30", "16:15", "16:30"]) {
    assert.equal(validarHorarioEspecial(data, h, 60), true, h);
  }
  for (const h of ["13:45", "16:45", "17:00", "17:30"]) {
    assert.equal(validarHorarioEspecial(data, h, 60), false, h);
  }
  assert.equal(validarHorarioEspecial(data, "15:00", 150), true);
  assert.equal(validarHorarioEspecial(data, "15:00", 151), false);
  assert.equal(validarHorarioEspecial(data, "14:10", 60), false);
});

test("quarta utiliza duas janelas reais e permite início :15/:45 sem exceções", () => {
  for (const data of ["2026-11-04", "2026-11-11", "2026-11-18", "2026-11-25", "2027-01-06"]) {
    for (const hora of ["09:00","09:15","09:30","10:45","11:30","14:00","14:15","15:15","16:30"]) {
      assert.equal(validarHorarioEspecial(data, hora, 60), true, hora);
    }
    for (const hora of ["08:45","11:45","12:15","13:45","16:45","17:00"]) {
      assert.equal(validarHorarioEspecial(data, hora, 60), false, hora);
    }
    assert.equal(validarHorarioEspecial(data, "09:00", 210), true);
    assert.equal(validarHorarioEspecial(data, "09:00", 211), false);
    assert.equal(validarHorarioEspecial(data, "14:00", 210), true);
    assert.equal(validarHorarioEspecial(data, "14:00", 211), false);
  }
});

test("frontend usa janelas compartilhadas com a API e resolução de 15 minutos", async () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const frontend = await readFile(path.join(raiz, "agendamento.js"), "utf8");
  assert.match(frontend, /obterJanelasAtendimento\(dataIso\)/);
  assert.match(frontend, /minuto \+= 15/);
  assert.match(frontend, /intervaloSobrepoeDisponibilidade\(atual, fimServico, intervalosIndisponiveis\)/);
  assert.doesNotMatch(frontend, /listarIniciosEncaixe/);
});

test("terça, quarta, quinta, sexta e sábado mantêm os slots administrativos", () => {
  const agora = new Date("2026-10-22T12:00:00Z");
  assert.deepEqual(listarSlotsGerenciaveis(dataDoDia(2), agora).slice(0, 2), [840, 855]);
  assert.deepEqual(listarSlotsGerenciaveis(dataDoDia(3), agora).slice(0, 2), [540, 555]);
  for (const weekday of [4, 5, 6]) assert.equal(validarHorarioEspecial(dataDoDia(weekday), "16:00", 60), true);
  assert.equal(listarSlotsGerenciaveis(dataDoDia(6), agora).includes(960), true);
  for (const dia of [4, 5]) {
    const slots = listarSlotsGerenciaveis(dataDoDia(dia), agora);
    assert.equal(slots.includes(810), true); // A pausa será fechada pela admin, não automaticamente.
    assert.equal(slots.includes(1110), true);
    assert.equal(slots.includes(1200), true); // 20h00–20h30 também administrável
    assert.equal(slots.includes(1230), true); // 20h30–21h00 também administrável
    assert.equal(slots.includes(1260), false);
  }
  const slotsSabado = listarSlotsGerenciaveis(dataDoDia(6), agora);
  assert.equal(slotsSabado.includes(810), true); // sábado sem almoço fixo
  assert.equal(slotsSabado.includes(1050), true); // 17h30–18h gerenciável
  assert.equal(slotsSabado.includes(1080), true); // 18h–18h30 gerenciável para exceção
  assert.equal(slotsSabado.includes(1110), false);
});

import { validarHorarioPix } from "../infra/backend/src/pixDisponibilidade.js";

test("validador backend aceita grade de 15 e aplica fechamento real dos períodos", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const v=(dia,hora,duracao)=>validarHorarioPix(dia,hora,duracao,now).valido;
  for(const hora of ["14:00","14:15","15:00","15:30","16:30"]) assert.equal(v("2026-11-03",hora,60),true,hora);
  assert.equal(v("2026-11-03","16:45",60),false);
  assert.equal(v("2026-11-03","15:30",121),false);
  assert.equal(v("2026-11-03","14:10",60),false);
  for(const [hora,duracao] of [["09:00",210],["10:00",150],["10:30",120],["11:00",90],["14:30",60],["15:00",120]]) {
    assert.equal(v("2026-11-04",hora,duracao),true,hora);
  }
  for(const [hora,duracao] of [["09:00",211],["11:45",60],["13:30",60],["16:45",60]]) {
    assert.equal(v("2026-11-04",hora,duracao),false,hora);
  }
  assert.equal(v("2026-12-02","14:00",60),false);
});

test("PIX preserva 21h quinta/sexta e exceção exata de sábado", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const v=(dia,hora,duracao)=>validarHorarioPix(dia,hora,duracao,now).valido;
  for(const dia of ["2026-11-05","2026-11-06"]) {
    for(const [h,d] of [["18:00",120],["19:15",90],["20:15",45],["20:30",30]]) assert.equal(v(dia,h,d),true,h);
    for(const [h,d] of [["20:15",60],["20:45",30],["21:00",15]]) assert.equal(v(dia,h,d),false,h);
  }
  for(const [h,d] of [["15:00",90],["15:30",90],["16:00",30],["16:00",150],["16:30",60],["17:30",30],["17:45",15]]) {
    assert.equal(v("2026-11-07",h,d),true,h);
  }
  for(const [h,d] of [["16:15",150],["16:30",120],["17:30",60],["18:00",15]]) {
    assert.equal(v("2026-11-07",h,d),false,h);
  }
});

test("API de disponibilidade bloqueia datas fora da janela antes de consultar o banco", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(path.join(root, "infra/backend/src/pixDisponibilidadeApi.js"), "utf8");
  const guard = source.indexOf("validarDataNaJanela(data, dependencies.now || new Date())");
  const query = source.indexOf("pool.query(");
  assert.ok(guard >= 0 && guard < query);
});
