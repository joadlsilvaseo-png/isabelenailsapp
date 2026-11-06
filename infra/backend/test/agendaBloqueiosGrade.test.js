import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DURACAO_BLOQUEIO_MINUTOS, planejarAlteracaoBloqueios, ConflitoBloqueio,
} from "../src/agendaBloqueiosGrade.mjs";

const legado=(inicio,uid="admin-isabele")=>({
  inicio_minuto:inicio, fim_minuto:inicio+30, alterado_por_uid:uid,
  criado_em:new Date("2026-10-27T13:00:00Z"),
});

test("185 bloqueios antigos permanecem idênticos sem operação explícita",()=>{
  const registros=Array.from({length:185},(_,i)=>legado(i*30));
  const plano=planejarAlteracaoBloqueios(registros,[],"reabrir","admin-isabele");
  assert.deepEqual(plano,{excluir:[],incluir:[]});
});

test("reabre 09:00–09:15 e preserva 09:15–09:30 do bloco legado",()=>{
  const original=legado(540);
  const p=planejarAlteracaoBloqueios([original],[540],"reabrir","admin-novo");
  assert.deepEqual(p.excluir.map(x=>[x.inicioMinuto,x.fimMinuto]),[[540,570]]);
  assert.deepEqual(p.incluir.map(x=>[x.inicioMinuto,x.fimMinuto]),[[555,570]]);
  assert.equal(p.incluir[0].uid,original.alterado_por_uid);
  assert.equal(p.incluir[0].criadoEm.getTime(),original.criado_em.getTime());
});

test("reabre 09:15–09:30 e preserva 09:00–09:15 do bloco legado",()=>{
  const p=planejarAlteracaoBloqueios([legado(540)],[555],"reabrir","admin-novo");
  assert.deepEqual(p.excluir.map(x=>[x.inicioMinuto,x.fimMinuto]),[[540,570]]);
  assert.deepEqual(p.incluir.map(x=>[x.inicioMinuto,x.fimMinuto]),[[540,555]]);
});

test("reabrir ambos os 15 minutos remove o bloco legado, sem novo bloqueio",()=>{
  const p=planejarAlteracaoBloqueios([legado(540)],[540,555],"reabrir","admin-novo");
  assert.equal(p.excluir.length,1);
  assert.equal(p.incluir.length,0);
});

test("fecha 15 min adjacente, mas nunca sobrepõe bloco de 30 ou de 15",()=>{
  const p=planejarAlteracaoBloqueios([legado(540)],[570],"fechar","admin-novo");
  assert.deepEqual(p.excluir,[]);
  assert.deepEqual(p.incluir.map(x=>[x.inicioMinuto,x.fimMinuto]),[[570,585]]);
  assert.throws(()=>planejarAlteracaoBloqueios([legado(540)],[555],"fechar","admin-novo"),ConflitoBloqueio);
  assert.throws(()=>planejarAlteracaoBloqueios([{inicio_minuto:570,fim_minuto:585}],[570],"fechar","admin-novo"),ConflitoBloqueio);
});

test("falha fechada para abertura inexistente e registros malformados",()=>{
  assert.equal(DURACAO_BLOQUEIO_MINUTOS,15);
  assert.throws(()=>planejarAlteracaoBloqueios([],[540],"reabrir","admin"),ConflitoBloqueio);
  assert.throws(()=>planejarAlteracaoBloqueios([legado(540)],[541],"reabrir","admin"),TypeError);
  assert.throws(()=>planejarAlteracaoBloqueios([{inicio_minuto:541,fim_minuto:571}],[570],"fechar","admin"));
});

test("backend mantém a mesma chave de lock do PIX e não altera tabelas financeiras",async()=>{
  const code=await readFile(new URL("../src/agendaBloqueios.js",import.meta.url),"utf8");
  assert.match(code,/pg_advisory_xact_lock\(hashtext\('isabele_pix_agenda'\)/);
  assert.match(code,/planejarAlteracaoBloqueios/);
  assert.doesNotMatch(code,/UPDATE public\.pix_reservas/);
});
