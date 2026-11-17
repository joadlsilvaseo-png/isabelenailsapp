import test from "node:test";
import assert from "node:assert/strict";
import { consultarDisponibilidadePix } from "../src/pixDisponibilidadeApi.js";

const now = new Date("2026-11-17T12:00:00-03:00");
function res() {
  return { status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(payload) { this.body = JSON.parse(payload); },
  };
}
const url = "/pix/disponibilidade?datas=2026-11-17%2C2026-11-18%2C2026-11-19";
test("consulta agrupada usa um SELECT, inclui reservas e bloqueios sem dados pessoais", async () => {
  const chamadas = [];
  const pool = { async query(sql, params) {
    chamadas.push({ sql, params });
    return { rows: [
      { data: "2026-11-17", inicio_minuto: 540, fim_minuto: 600, tipo: "reserva", sequencial_mesma_cliente: false },
      { data: "2026-11-18", inicio_minuto: 600, fim_minuto: 630, tipo: "bloqueio", sequencial_mesma_cliente: false },
      { data: "2026-11-19", inicio_minuto: 660, fim_minuto: 720, tipo: "reserva", sequencial_mesma_cliente: true },
    ] };
  } };
  const resposta = res();
  await consultarDisponibilidadePix({url,headers:{}},resposta,pool,{now,verificarUsuario:async()=>"cliente-a"});
  assert.equal(resposta.status,200);
  assert.equal(chamadas.length,1);
  assert.deepEqual(chamadas[0].params,[["2026-11-17","2026-11-18","2026-11-19"],"cliente-a"]);
  assert.match(chamadas[0].sql,/FROM public\.pix_reservas/);
  assert.match(chamadas[0].sql,/FROM public\.agenda_bloqueios/);
  assert.match(chamadas[0].sql,/estado IN \('reservada', 'confirmada'\)/);
  assert.doesNotMatch(chamadas[0].sql,/\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.equal(resposta.body.intervalosPorData["2026-11-18"][0].tipo,"bloqueio");
  assert.equal(resposta.body.intervalosPorData["2026-11-19"][0].sequencialMesmaCliente,true);
  assert.equal(JSON.stringify(resposta.body).includes("cliente-a"),false);
  assert.equal(resposta.headers["Cache-Control"],"no-store");
});
test("período não autenticado ou inválido não toca PostgreSQL", async () => {
  let consultas=0;
  const pool={async query(){consultas++;return {rows:[]};}};
  for(const [urlTeste,auth,status] of [
    [url,async()=>{throw Error("bad token");},401],
    ["/pix/disponibilidade?datas=2026-11-17,2026-11-17",async()=> "a",400],
    ["/pix/disponibilidade?datas=2026-11-17,2026-11-25",async()=> "a",400],
    ["/pix/disponibilidade?datas=2026-11-17,2026-11-18&agendamentoId=x",async()=> "a",400],
    ["/pix/disponibilidade?datas=2026-12-15",async()=> "a",400],
    ["/pix/disponibilidade?datas=2026-11-18,2026-11-17",async()=> "a",400],
  ]) {
    const resposta=res();
    await consultarDisponibilidadePix({url:urlTeste,headers:{}},resposta,pool,{now,verificarUsuario:auth});
    assert.equal(resposta.status,status,urlTeste);
  }
  assert.equal(consultas,0);
});
test("erro SQL e linhas malformadas não fabricam horários disponíveis",async()=>{
  for(const pool of [
    {async query(){throw Error("db offline");}},
    {async query(){return {rows:[{data:"2026-11-17",inicio_minuto:800,fim_minuto:600,tipo:"reserva"}]};}},
  ]){
    const resposta=res();
    await consultarDisponibilidadePix({url,headers:{}},resposta,pool,{now,verificarUsuario:async()=>"a"});
    assert.equal(resposta.status,503);
    assert.equal("intervalosPorData" in resposta.body,false);
  }
});
