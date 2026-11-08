import test from "node:test";
import assert from "node:assert/strict";
import { criarAdaptadorGoogleCalendar } from "../src/googleCalendarEvents.js";
const eventId="legacy_event_12345", agendamentoId="reserva_123";
const legacyEventId="evt_reserva_123";
const ENV={GOOGLE_CALENDAR_OAUTH_ENABLED:"true",GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED:"true"};
const payload={agendamentoId,eventId,legacyEventId,nomeCliente:"Pessoa Exemplo",servico:"Gel",
  inicio:"2026-12-19T09:00:00-03:00",fim:"2026-12-19T10:00:00-03:00"};
const antigo=(mod={})=>({
  id:eventId,etag:'"1"',status:"confirmed",
  description:"Sinal: "+legacyEventId+"\nServico original",
  summary:"Gel - Pessoa Exemplo",
  start:{dateTime:"2026-12-19T08:00:00-03:00"},
  end:{dateTime:"2026-12-19T09:00:00-03:00"},...mod,
});
const res=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>body});
function setup(responder,env=ENV){
  const reqs=[];
  const adapter=criarAdaptadorGoogleCalendar({
    calendarId:"test@example.com",env,obterAccessToken:async()=>"fake",
    fetcher:async(url,ops)=>{reqs.push({url,ops});return responder(url,ops,reqs.length);},
  });
  return {adapter,reqs};
}
test("PATCH legado exige marcador exato, etag e ID real; nunca gera outro evento",async()=>{
  const t=setup((url,ops)=>res(200,ops.method==="GET"?antigo():antigo({
    etag:'"2"',start:{dateTime:payload.inicio},end:{dateTime:payload.fim},
  })));
  const saida=await t.adapter.atualizarEventoLegado(payload);
  assert.deepEqual(saida,{eventId,atualizado:true});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET","PATCH"]);
  assert.equal(t.reqs[1].ops.headers["If-Match"],'"1"');
  const body=JSON.parse(t.reqs[1].ops.body);
  assert.equal(body.summary,"Gel - Pessoa Exemplo");
  assert.equal(Object.hasOwn(body,"description"),false);
  assert.equal(Object.hasOwn(body,"extendedProperties"),false);
});
test("retentativa apos timeout confirma evento ja atualizado sem novo PATCH",async()=>{
  const t=setup(()=>res(200,antigo({start:{dateTime:payload.inicio},end:{dateTime:payload.fim}})));
  assert.deepEqual(await t.adapter.atualizarEventoLegado(payload),
    {eventId,atualizado:false,jaEstavaAtualizado:true});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET"]);
});
test("nao aceita substring id de outro agendamento",async()=>{
  const t=setup(()=>res(200,antigo({description:legacyEventId+"-outra"})));
  await assert.rejects(t.adapter.atualizarEventoLegado(payload),{codigo:"GOOGLE_LEGADO_SEM_MARCADOR"});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET"]);
});
test("nao altera evento com marcador privado de outra reserva",async()=>{
  const t=setup(()=>res(200,antigo({extendedProperties:{private:{
    isabeleOrigem:"isabele-vps",isabeleAgendamentoId:"outra",
  }}})));
  await assert.rejects(t.adapter.atualizarEventoLegado(payload),{codigo:"GOOGLE_LEGADO_OUTRO_AGENDAMENTO"});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET"]);
});
test("DELETE legado GET/DELETE usa etag, referencia exata e nenhum fallback",async()=>{
  const t=setup((url,ops)=>ops.method==="GET"?res(200,antigo()):res(204));
  assert.deepEqual(await t.adapter.excluirEventoLegado({agendamentoId,eventId,legacyEventId}),
    {eventId,excluido:true,jaAusente:false});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET","DELETE"]);
  assert.equal(t.reqs[1].ops.headers["If-Match"],'"1"');
});
test("DELETE sem correspondencia retorna ja ausente e nao repete",async()=>{
  const t=setup(()=>res(404));
  const r=await t.adapter.excluirEventoLegado({agendamentoId,eventId,legacyEventId});
  assert.equal(r.jaAusente,true);assert.equal(t.reqs.length,1);
});
test("escrita desligada recusa antes de qualquer GET",async()=>{
  const t=setup(()=>{throw Error("nao chamar");},{GOOGLE_CALENDAR_OAUTH_ENABLED:"true"});
  await assert.rejects(t.adapter.atualizarEventoLegado(payload),{codigo:"CALENDAR_ESCRITA_DESATIVADA"});
  await assert.rejects(t.adapter.excluirEventoLegado({agendamentoId,eventId,legacyEventId}),
    {codigo:"CALENDAR_ESCRITA_DESATIVADA"});
  assert.equal(t.reqs.length,0);
});
test("marcador ausente nao pode excluir evento de outra cliente",async()=>{
  const t=setup(()=>res(200,antigo({description:"nada sobre a reserva"})));
  await assert.rejects(t.adapter.excluirEventoLegado({agendamentoId,eventId,legacyEventId}),
    {codigo:"GOOGLE_LEGADO_SEM_MARCADOR"});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET"]);
});
test("conflito ETag nao e ignorado",async()=>{
  const t=setup((url,ops)=>ops.method==="GET"?res(200,antigo()):res(412));
  await assert.rejects(t.adapter.atualizarEventoLegado(payload),
    {codigo:"GOOGLE_CALENDAR_CONFLITO_VERSAO"});
  assert.deepEqual(t.reqs.map(x=>x.ops.method),["GET","PATCH"]);
});
