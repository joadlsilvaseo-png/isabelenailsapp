import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { criarPonteCalendarDireto } from "../src/googleCalendarDirectBridge.js";
import { gerarIdEventoGoogle } from "../src/googleCalendarEvents.js";

const { Pool }=pg;
const CAL="ponte-teste@example.com";
const ENV={
 GOOGLE_CALENDAR_OAUTH_ENABLED:"true",GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED:"true",
 GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED:"true",GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED:"true",
 GOOGLE_CALENDAR_ID:CAL,GOOGLE_CALENDAR_CUTOVER_STARTED_AT:"2026-11-08T20:00:00-03:00",
 GOOGLE_CALENDAR_DIRECT_REAGENDAR_PAGO_ENABLED:"true",
 GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED:"true",
 GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED:"true",
};
const payload={
 eventId:"evt_legado-bridge-1",
 operationId:"11111111-2222-4333-8444-555555555555",
 nomeCliente:"Cliente Ficticia",servico:"Manicure Gel",
 dataInicio:"2026-12-20T10:00:00",duracaoMinutos:90,
 origemData:"2026-12-20",origemHorario:"09:00",
};
function eventoLegado(){
 return {id:"evento-legado-bridge-1",status:"confirmed",etag:'"v1"',
  description:"Agendamento: evt_legado-bridge-1",
  summary:"Manicure Gel - Cliente Ficticia",
  start:{dateTime:"2026-12-20T09:00:00-03:00"},
  end:{dateTime:"2026-12-20T10:30:00-03:00"}};
}
const target=()=>{
 const inicio="2026-12-20T10:00:00-03:00";
 return {inicio,fim:new Date(Date.parse(inicio)+90*60000).toISOString()};
};
const atualizar=ev=>({
 ...ev,summary:payload.servico+" - "+payload.nomeCliente,
 start:{dateTime:target().inicio},end:{dateTime:target().fim},
});
async function criarLinkLegado(pool){
 await pool.query(
  "INSERT INTO public.google_calendar_event_links "+
  "(agendamento_id,calendar_id,google_event_id,origem,metodo_verificacao,verificado_em,verificado_por) "+
  "VALUES ('legado-bridge-1',$1,'evento-legado-bridge-1','legado_validado', "+
  "'revisao_manual_confirmada',NOW(),'testes-ci') ON CONFLICT (agendamento_id) DO NOTHING",
  [CAL],
 );
}
test("PG17 gateway: reagendamento legado, persistencia e idempotencia",async()=>{
 const pool=new Pool({max:3});
 try{
  await criarLinkLegado(pool);
  let atual=eventoLegado(),patches=0;
  const fake={
   atualizarEventoLegado:async()=>{patches++;atual=atualizar(atual);},
   consultarEventoLegado:async()=>atual,
  };
  const ponte=criarPonteCalendarDireto(pool,{env:ENV,adapterFactory:()=>fake});
  const primeiro=await ponte.reagendarPago(payload);
  assert.equal(primeiro.confirmado,true);
  assert.equal(patches,1);
  const segundo=await ponte.reagendarPago(payload);
  assert.equal(segundo.jaConcluida,true);
  assert.equal(patches,1);
  const db=await pool.query(
   "SELECT estado FROM public.google_calendar_sync_operations WHERE operation_id=$1",
   [primeiro.operationId],
  );
  assert.equal(db.rows[0].estado,"concluida");
 }finally{await pool.end();}
});
test("PG17 gateway: timeout apos PATCH aplicado recupera por GET, sem outro PATCH",async()=>{
 const pool=new Pool({max:3});
 try{
  const id="legado-bridge-2",evId="evento-legado-bridge-2";
  await pool.query(
   "INSERT INTO public.google_calendar_event_links "+
   "(agendamento_id,calendar_id,google_event_id,origem,metodo_verificacao,verificado_em,verificado_por) "+
   "VALUES ($1,$2,$3,'legado_validado','revisao_manual_confirmada',NOW(),'testes-ci')",
   [id,CAL,evId],
  );
  let estado={...eventoLegado(),id:evId,description:"Ref: evt_"+id},patches=0;
  const fake={
   atualizarEventoLegado:async()=>{
    patches++;estado=atualizar(estado);throw new Error("timeout ficticio apos gravação");
   },
   consultarEventoLegado:async()=>estado,
  };
  const ponte=criarPonteCalendarDireto(pool,{env:ENV,adapterFactory:()=>fake});
  const pedido={...payload,eventId:"evt_"+id,
   operationId:"22222222-3333-4444-8555-666666666666"};
  await assert.rejects(ponte.reagendarPago(pedido),/timeout ficticio/);
  assert.equal(patches,1);
  const recovered=await ponte.reagendarPago(pedido);
  assert.equal(recovered.recuperado,true);
  assert.equal(patches,1);
  const result=await pool.query(
   "SELECT estado FROM public.google_calendar_sync_operations WHERE operation_id=$1",
   [recovered.operationId],
  );
  assert.equal(result.rows[0].estado,"concluida");
 }finally{await pool.end();}
});
test("PG17 gateway: timeout sem alteracao nao reenvia PATCH",async()=>{
 const pool=new Pool({max:3});
 try{
  const id="legado-bridge-3",evId="evento-legado-bridge-3";
  await pool.query(
   "INSERT INTO public.google_calendar_event_links "+
   "(agendamento_id,calendar_id,google_event_id,origem,metodo_verificacao,verificado_em,verificado_por) "+
   "VALUES ($1,$2,$3,'legado_validado','revisao_manual_confirmada',NOW(),'testes-ci')",
   [id,CAL,evId],
  );
  let patches=0;
  const fake={
   atualizarEventoLegado:async()=>{patches++;throw new Error("timeout ficticio");},
   consultarEventoLegado:async()=>({...eventoLegado(),id:evId,description:"Ref: evt_"+id}),
  };
  const ponte=criarPonteCalendarDireto(pool,{env:ENV,adapterFactory:()=>fake});
  const pedido={...payload,eventId:"evt_"+id,
   operationId:"33333333-4444-4555-8666-777777777777"};
  await assert.rejects(ponte.reagendarPago(pedido),/timeout ficticio/);
  await assert.rejects(ponte.reagendarPago(pedido),
    {codigo:"OPERACAO_PENDENTE_REVISAO"});
  assert.equal(patches,1);
 }finally{await pool.end();}
});
test("PG17 gateway: cancela apenas link validado por GET/DELETE",async()=>{
 const pool=new Pool({max:3});
 try{
  let apagado=false,deletes=0;
  const fake={
   excluirEventoLegado:async()=>{apagado=true;deletes++;},
   consultarEventoLegado:async()=>apagado?null:eventoLegado(),
  };
  const ponte=criarPonteCalendarDireto(pool,{env:ENV,adapterFactory:()=>fake});
  const out=await ponte.cancelar({agendamento_id:"legado-bridge-1"});
  assert.equal(out.confirmado,true);
  assert.equal(deletes,1);
  const link=await pool.query(
   "SELECT situacao FROM public.google_calendar_event_links WHERE agendamento_id='legado-bridge-1'",
  );
  assert.equal(link.rows[0].situacao,"cancelado");
 }finally{await pool.end();}
});
test("PG17 gateway: nova reserva so cria com autorizacao previamente consumivel",async()=>{
 const pool=new Pool({max:3});
 try{
  const id="nova-bridge-1",eventId=gerarIdEventoGoogle(id);
  await pool.query(
   "INSERT INTO public.google_calendar_creation_authorizations "+
   "(agendamento_id,calendar_id,autorizacao,evidencia_sha256,autorizado_por) "+
   "VALUES ($1,$2,'nova_reserva_verificada',$3,'testes-ci')",
   [id,CAL,"a".repeat(64)],
  );
  let atual=null,posts=0;
  const fake={
   criarEvento:async(dados)=>{
    posts++;atual={id:eventId,status:"confirmed",
     summary:dados.servico+" - "+dados.nomeCliente,
     start:{dateTime:dados.inicio},end:{dateTime:dados.fim},
     extendedProperties:{private:{isabeleOrigem:"isabele-vps",isabeleAgendamentoId:id}}};
   },
   consultarEvento:async()=>atual,
  };
  const ponte=criarPonteCalendarDireto(pool,{env:ENV,adapterFactory:()=>fake});
  const pedido={agendamento_id:id,data_servico_iso:"2026-12-22",
    horario:"09:00:00",duracao_minutos:60,
    nome_cliente:"Cliente Nova",servico:"Manicure"};
  const resposta=await ponte.criarPix(pedido);
  assert.equal(resposta.confirmado,true);
  assert.equal(posts,1);
  const link=await pool.query(
   "SELECT origem,google_event_id FROM public.google_calendar_event_links WHERE agendamento_id=$1",[id],
  );
  assert.deepEqual(link.rows[0],{origem:"vps",google_event_id:eventId});
  assert.equal((await ponte.criarPix(pedido)).jaConcluida,true);
  assert.equal(posts,1);
 }finally{await pool.end();}
});
