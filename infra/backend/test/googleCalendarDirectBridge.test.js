import test from "node:test";
import assert from "node:assert/strict";
import { criarPonteCalendarDireto } from "../src/googleCalendarDirectBridge.js";
import { autorizarCriacaoNovoCalendar } from "../src/googleCalendarNewBookingAuth.js";

const pool = { query: async () => { throw Error("Nao consultar producao"); } };
const ID="agend-teste-123";
const CAL="profissional@example.com";
const BASE={
 GOOGLE_CALENDAR_OAUTH_ENABLED:"true",
 GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED:"true",
 GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED:"true",
 GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED:"true",
 GOOGLE_CALENDAR_ID:CAL,
 GOOGLE_CALENDAR_CUTOVER_STARTED_AT:"2026-11-08T20:00:00-03:00",
};
const row={
  agendamento_id:ID, data_servico_iso:"2026-12-20",horario:"09:00:00",
  duracao_minutos:60,nome_cliente:"Cliente ficticia",servico:"Gel",
};

test("sem flags usa GAS: ponte nao instancia adapter nem consulta PG",async()=>{
  let initialized=0;
  const bridge=criarPonteCalendarDireto(pool,{
    env:{}, adapterFactory:()=>{ initialized++;throw Error("adapter chamado"); },
  });
  for(const flow of ["criar_pix","cancelar","reagendar_pago","alterar_servico"]){
    assert.equal(bridge.habilitado(flow),false);
  }
  await assert.rejects(bridge.criarPix(row),{codigo:"FLUXO_DESATIVADO"});
  assert.equal(initialized,0);
});

test("flag isolada sem todas as travas bloqueia o modo direto",()=>{
  const bridge=criarPonteCalendarDireto(pool,{
    env:{GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED:"true",GOOGLE_CALENDAR_ID:CAL},
  });
  assert.throws(()=>bridge.habilitado("cancelar"),
    {codigo:"CUTOVER_FLAGS_INCOMPLETAS"});
});

test("criacao direta exige horario de corte explicito no inicio do processo",()=>{
  for(const value of ["", "2026-11-08","2031-01-01T00:00:00Z"]){
    const bridge=criarPonteCalendarDireto(pool,{
      env:{...BASE,GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED:"true",
        GOOGLE_CALENDAR_CUTOVER_STARTED_AT:value},
    });
    assert.throws(()=>bridge.habilitado("criar_pix"),
      {codigo:"CUTOVER_START_INVALIDO"});
  }
});

test("cada fluxo pode ser selecionado independentemente",()=>{
  const b=criarPonteCalendarDireto(pool,{
    env:{...BASE,GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED:"true"},
  });
  assert.equal(b.habilitado("criar_pix"),false);
  assert.equal(b.habilitado("cancelar"),true);
  assert.equal(b.habilitado("alterar_servico"),false);
  assert.equal(b.habilitado("reagendar_pago"),false);
});

test("autorizacao nova nao faz SQL quando modo GAS esta ativo",async()=>{
  const r=await autorizarCriacaoNovoCalendar(pool,{
    outboxId:123,agendamentoId:ID,env:{},
  });
  assert.deepEqual(r,{autorizada:false,desativada:true});
});

test("autorizacao rejeita data de corte ausente e IDs invalidos",async()=>{
  await assert.rejects(autorizarCriacaoNovoCalendar(pool,{
    outboxId:123,agendamentoId:ID,env:{
      ...BASE,GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED:"true",
      GOOGLE_CALENDAR_CUTOVER_STARTED_AT:"",
    },
  }),{codigo:"INICIO_CUTOVER_INVALIDO"});
  await assert.rejects(autorizarCriacaoNovoCalendar(pool,{
    outboxId:123,agendamentoId:"../../invalido",env:{
      ...BASE,GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED:"true",
    },
  }),{codigo:"REGISTRO_INVALIDO"});
});

test("autorizacao usa somente INSERT SELECT condicional e hash de evidencia",async()=>{
  const chamadas=[];
  const db={query:async(sql,args)=>{chamadas.push({sql,args});return{rows:[{agendamento_id:ID}]};}};
  const result=await autorizarCriacaoNovoCalendar(db,{
    outboxId:123,agendamentoId:ID,env:{
      ...BASE,GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED:"true",
    },
  });
  assert.deepEqual(result,{autorizada:true});
  assert.equal(chamadas.length,1);
  assert.match(chamadas[0].sql,/WHERE fila.id=\$1 AND fila.agendamento_id=\$2/);
  assert.match(chamadas[0].sql,/fila.tentativas=0/);
  assert.match(chamadas[0].sql,/fila.criado_em >= \$5::timestamptz/);
  assert.match(chamadas[0].sql,/ON CONFLICT \(agendamento_id\) DO NOTHING/);
  assert.match(chamadas[0].args[3],/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(chamadas).includes("Cliente ficticia"));
});

test("autorizacao repetida ou fora da janela nunca gera liberacao",async()=>{
  const db={query:async()=>({rows:[]})};
  const result=await autorizarCriacaoNovoCalendar(db,{
    outboxId:123,agendamentoId:ID,
    env:{...BASE,GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED:"true"},
  });
  assert.equal(result.autorizada,false);
});
