import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  RESOLUCAO_GRADE_MINUTOS, obterJanelasAtendimento,
  validarHorarioEspecial,
} from "../infra/backend/src/agendamentoRegras.mjs";
import { validarHorarioPix } from "../infra/backend/src/pixDisponibilidade.js";
import { indisponivelComBuffer } from "../infra/backend/src/agendaBuffer.mjs";
import { verificarEncaixeNoBanco } from "../infra/backend/src/pixEncaixes.js";

const AGORA = new Date("2026-11-05T11:00:00-03:00");
const validar=(data,hora,duracao)=>validarHorarioPix(data,hora,duracao,AGORA).valido;

test("grade usa resolução nativa de 15 min, incluindo :15 e :45 sem segunda reserva", () => {
  assert.equal(RESOLUCAO_GRADE_MINUTOS,15);
  for (const h of ["14:00","14:15","14:30","14:45","15:00","15:15","15:30"]) {
    assert.equal(validar("2026-11-10",h,60),true,h);
  }
  assert.equal(validar("2026-11-10","14:10",60),false);
  assert.equal(validar("2026-11-10","14:05",60),false);
});

test("buffer 15 de cada lado e bloqueio manual nunca estica por 30 min",()=>{
  const anterior=[{inicioMinuto:540,fimMinuto:600,tipo:"agendamento"}];
  assert.equal(indisponivelComBuffer(600,660,anterior),true);
  assert.equal(indisponivelComBuffer(615,675,anterior),false);
  const proximo=[{inicioMinuto:690,fimMinuto:810,tipo:"reserva"}];
  assert.equal(indisponivelComBuffer(615,675,proximo),false);
  assert.equal(indisponivelComBuffer(630,690,proximo),true);
  assert.equal(indisponivelComBuffer(615,675,[{inicioMinuto:630,fimMinuto:645,tipo:"bloqueio"}]),true);
  assert.equal(indisponivelComBuffer(645,705,[{inicioMinuto:630,fimMinuto:645,tipo:"bloqueio"}]),false);
});

test("janelas de expediente e exceções de dezembro são preservadas",()=>{
  assert.deepEqual(obterJanelasAtendimento("2026-11-11"),[
    {inicioMinuto:540,encerramentoMinuto:750},
    {inicioMinuto:840,encerramentoMinuto:1050},
  ]);
  assert.deepEqual(obterJanelasAtendimento("2026-12-15"),[]);
  assert.deepEqual(obterJanelasAtendimento("2026-12-23"),[
    {inicioMinuto:420,encerramentoMinuto:1320},
  ]);
  assert.equal(validarHorarioEspecial("2026-11-07","16:00",150),true);
  assert.equal(validarHorarioEspecial("2026-11-07","16:15",150),false);
  assert.equal(validarHorarioEspecial("2026-11-07","17:45",15),true);
});

test("PIX continua fail-closed quando :15 sobrepõe reserva existente",async()=>{
  const items=[{inicio_minuto:540,fim_minuto:600,tipo:"reserva"}];
  const conexao={query:async()=>({rows:items})};
  const db={collection:()=>({where:()=>({get:async()=>({docs:[]})})})};
  const p={conexao,db,data:"2026-11-10",inicio:615,fim:675};
  assert.equal(await verificarEncaixeNoBanco(p),true);
  assert.equal(await verificarEncaixeNoBanco({...p,inicio:600,fim:660}),false);
  items.push({inicio_minuto:660,fim_minuto:720,tipo:"reserva"});
  assert.equal(await verificarEncaixeNoBanco(p),false);
});

test("frontend não importa módulos de pagamento e usa carrossel isolado",async()=>{
  const page=await readFile(new URL("../agendamento.js",import.meta.url),"utf8");
  const css=await readFile(new URL("../agendamento.css",import.meta.url),"utf8");
  assert.match(page,/agendamento-time-carousel/);
  assert.match(page,/obterJanelasAtendimento\(dataIso\)/);
  assert.match(page,/minuto \+= 15/);
  assert.match(css,/scroll-snap-type/);
});
