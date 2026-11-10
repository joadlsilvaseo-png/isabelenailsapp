import test from "node:test";
import assert from "node:assert/strict";
import { prepararCandidatosLegados } from "../src/googleCalendarLegacyCandidates.js";

const calendarId="isabele@example.com";
const id = "agendamento-test-1";
const ref = "evt_"+id;
const start = "2026-12-01T10:00:00-03:00";
const end = "2026-12-01T11:30:00-03:00";
const outbox=()=>({
  agendamento_id:id, event_id:ref, status:"enviado",
  data_iso:"2026-12-01",hora_iso:"10:00",duracao_minutos:90,
  nome_cliente:"Cliente de Teste",servico:"Manicure em Gel",
});
const firestore=(status="confirmado")=>({
  id, calendarEventId:ref, data:"2026-12-01", horario:"10:00",
  duracaoSnapshot:90,status,
});
const evento=(opts={})=>({
  id:"evento-00001", description:"Agendamento: "+ref+"\nOrigem: teste",
  status:"confirmed", start:{dateTime:start},end:{dateTime:end},
  summary:"Cliente de Teste - Manicure em Gel",...opts,
});
const input=(modify={})=>({
  calendarId,outbox:[outbox()],firestore:[firestore()],
  eventos:[evento()],cancelamentos:[],vinculos:[],...modify,
});
const run=(modify)=>prepararCandidatosLegados(input(modify));
function assertRevisao(motivo, args){
  const r=run(args);
  assert.equal(r.resumo.candidatosARevisao,0);
  assert.equal(r.resumo.excecoes[motivo],1,JSON.stringify(r.resumo));
  assert.deepEqual(r.candidatos,[]);
}

test("referencia unica, mesmo horario, duracao e dados: prepara candidato SEM inserir",()=>{
  const r=run();
  assert.equal(r.somenteLeitura,true);
  assert.equal(r.resumo.matchesUnicos,1);
  assert.equal(r.resumo.candidatosARevisao,1);
  assert.equal(r.resumo.vinculacoesCriadas,0);
  assert.deepEqual(r.revisoes,[]);
  const candidate=r.candidatos[0];
  assert.deepEqual(
    [candidate.agendamentoId,candidate.calendarId,candidate.googleEventId,
      candidate.legacyEventId,candidate.origem,candidate.metodoVerificacao],
    [id,calendarId,"evento-00001",ref,"legado_validado","revisao_manual_confirmada"],
  );
  assert.match(candidate.fingerprintEvidencia,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(r).includes("Cliente de Teste"));
  assert.ok(!JSON.stringify(r).includes("Manicure em Gel"));
});

test("status concluido e reagendado sao historicos validos, sem exigir confirmacao ativo",()=>{
  for(const status of ["confirmado","concluido","finalizado","realizado","reagendado"]){
    assert.equal(run({firestore:[firestore(status)]}).resumo.candidatosARevisao,1,status);
  }
});

test("status nao conhecido e cancelado ficam sob revisao",()=>{
  for(const status of ["revisar","cancelado","expirado","", "bloqueado"]){
    assertRevisao("FIRESTORE_STATUS_REVISAR",{firestore:[firestore(status)]});
  }
});

test("eventos removidos por cancelamento concluido nao sao recriados",()=>{
  const r=run({eventos:[],cancelamentos:[{agendamento_id:id,estado:"concluida"}]});
  assert.equal(r.resumo.cancelamentosSemEvento,1);
  assert.equal(r.resumo.candidatosARevisao,0);
  assert.equal(r.revisoes.length,0);
});

test("ausente sem cancelamento vira alerta",()=>{
  assertRevisao("SEM_EVENTO",{eventos:[]});
});

test("cancelamento existente bloqueia vinculo mesmo quando evento encontrado",()=>{
  for(const estado of ["solicitada","concluida"]){
    assertRevisao("CANCELAMENTO_EXISTENTE",{
      cancelamentos:[{agendamento_id:id,estado}],
    });
  }
});

test("dispensado nao e liberado por marcador existente",()=>{
  assertRevisao("OUTBOX_NAO_ENVIADA",{outbox:[{...outbox(),status:"dispensado"}]});
});

test("marcador substring parcial nao vira correspondencia",()=>{
  assertRevisao("SEM_EVENTO",{eventos:[evento({
    description:"Agendamento: "+ref+"-outra",
  })]});
});

test("marcador exato aceita quebra de linha e dois-pontos",()=>{
  const r=run({eventos:[evento({description:"Ref: "+ref+"\nDetalhes"})]});
  assert.equal(r.resumo.candidatosARevisao,1);
});

test("duas ocorrencias distintas com mesmo marcador bloqueiam",()=>{
  assertRevisao("MULTIPLOS_EVENTOS",{
    eventos:[evento(),evento({id:"evento-00002"})],
  });
});

test("um unico evento reivindicado por duas reservas bloqueia ambos",()=>{
  const second={...outbox(),agendamento_id:"agendamento-test-2",
    event_id:"evt_agendamento-test-2"};
  const e=evento({
    description:ref+"\n"+second.event_id,
  });
  const result=run({
    outbox:[outbox(),second],
    firestore:[firestore(),{...firestore(),id:second.agendamento_id,
      calendarEventId:second.event_id}],
    eventos:[e],
  });
  assert.equal(result.resumo.candidatosARevisao,0);
  assert.equal(result.resumo.excecoes.EVENTO_COMPARTILHADO,2);
});

test("vinculo preexistente nao regravado",()=>{
  assertRevisao("VINCULO_JA_EXISTENTE",{
    vinculos:[{agendamento_id:id,google_event_id:"evento-00001",calendar_id:calendarId}],
  });
});

test("vinculo anterior divergente bloqueia o candidato",()=>{
  assertRevisao("VINCULO_EXISTENTE_DIVERGENTE",{
    vinculos:[{agendamento_id:id,google_event_id:"evento-99999",calendar_id:calendarId}],
  });
});

test("evento ja vinculado a outra reserva bloqueia candidato",()=>{
  assertRevisao("EVENTO_JA_VINCULADO",{
    vinculos:[{agendamento_id:"outro123",google_event_id:"evento-00001",calendar_id:calendarId}],
  });
});

test("evento cancelado ou recorrente bloqueia vinculo",()=>{
  assertRevisao("EVENTO_STATUS_NAO_CONFIRMADO",{
    eventos:[evento({status:"cancelled"})],
  });
  assertRevisao("RECORRENCIA",{
    eventos:[evento({recurringEventId:"serie-test"})],
  });
});

test("Firestore sem documento, ID divergente ou duracao diferente bloqueia",()=>{
  assertRevisao("FIRESTORE_AUSENTE",{firestore:[]});
  assertRevisao("REFERENCIA_FIRESTORE_DIVERGENTE",{
    firestore:[{...firestore(),calendarEventId:"evt_outro123"}],
  });
  assertRevisao("DURACAO_FIRESTORE_DIVERGENTE",{
    firestore:[{...firestore(),duracaoSnapshot:60}],
  });
});

test("novembro alteracao servico: duracao antiga 150 e atual 90 exige revisao",()=>{
  assertRevisao("DURACAO_OUTBOX_DIVERGENTE",{
    outbox:[{...outbox(),duracao_minutos:150}],
  });
});

test("dezembro alteracao servico: duracao antiga 90 e atual 150 exige revisao",()=>{
  assertRevisao("DURACAO_OUTBOX_DIVERGENTE",{
    firestore:[{...firestore(),duracaoSnapshot:150}],
    eventos:[evento({end:{dateTime:"2026-12-01T12:30:00-03:00"}})],
  });
});

test("dezembro reagendamento: horario Firestore diverge do evento",()=>{
  assertRevisao("HORARIO_FIRESTORE_DIVERGENTE",{
    firestore:[{...firestore(),horario:"07:00"}],
  });
});

test("horario original diverge sem deduzir correspondencia",()=>{
  assertRevisao("HORARIO_OUTBOX_DIVERGENTE",{
    outbox:[{...outbox(),hora_iso:"09:00"}],
  });
});

test("nome ou servico divergente exige revisao",()=>{
  assertRevisao("TITULO_DIVERGENTE",{
    eventos:[evento({summary:"Outro nome - outro servico"})],
  });
});

test("duplicatas de registro e evento falham fechado",()=>{
  assert.throws(()=>run({outbox:[outbox(),outbox()]}),
    {codigo:"OUTBOX_DUPLICADA"});
  assert.throws(()=>run({eventos:[evento(),evento()]}),
    {codigo:"EVENTO_REPETIDO"});
  assert.throws(()=>run({firestore:[firestore(),firestore()]}),
    {codigo:"FIRESTORE_REPETIDO"});
});

test("limites de fontes evitam relatorios incompletos",()=>{
  assert.throws(()=>run({eventos:Array(1501).fill(evento())}),
    {codigo:"LISTA_EVENTOS_INVALIDA"});
});

test("hash da evidencia muda ao mudar a identidade remota",()=>{
  const first=run().candidatos[0].fingerprintEvidencia;
  const changed=run({eventos:[evento({id:"evento-00002"})]})
    .candidatos[0].fingerprintEvidencia;
  assert.notEqual(first,changed);
});
