/**
 * CORRECAO PONTUAL: 14/11, 10/12 (vincular); 21/12 -> 22/12 (mesmo events.id).
 *
 * Executar em stdin no container API com flags de escrita ativadas APENAS
 * neste processo, mas flags do cutover/worker da API de producao desligadas.
 * Nunca insere/recria eventos; nunca atualiza Firestore ou PIX.
 *
 * Nao imprime identificadores, nomes, titulos, descricoes ou credenciais.
 * Os 111 vinculos ja importados permanecem intocados.
 */
import pg from "pg";
import {initializeApp,applicationDefault,getApps} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";
import {createHash} from "node:crypto";
import {criarAdaptadorGoogleCalendarComOAuth} from "/app/src/googleCalendarTokenProvider.js";
import {configuracaoCalendarOAuth} from "/app/src/googleCalendarOAuth.js";

const CASOS=[
  {codigo:"14NOV",dia:"2026-11-14",hora:"09:00",inicioEsperado:"2026-11-14T09:00",duracao:90},
  {codigo:"10DEZ",dia:"2026-12-10",hora:"11:00",inicioEsperado:"2026-12-10T11:00",duracao:150},
  {codigo:"21DEZ",dia:"2026-12-21",hora:"07:00",inicioEsperado:"2026-12-22T07:00",duracao:90},
];
const FUSO="America/Sao_Paulo";
const formato=new Intl.DateTimeFormat("en-US",{timeZone:FUSO,hourCycle:"h23",
  year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
function erro(code){throw Object.assign(new Error(code),{codigo:code});}
function local(iso){
  if(typeof iso!=="string"||!Number.isFinite(Date.parse(iso)))return null;
  const p=Object.fromEntries(formato.formatToParts(new Date(iso))
    .filter(x=>["year","month","day","hour","minute"].includes(x.type))
    .map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day+"T"+p.hour+":"+p.minute;
}
function minutos(ev){
  let a=Date.parse(ev?.start?.dateTime),b=Date.parse(ev?.end?.dateTime);
  return Number.isFinite(a)&&Number.isFinite(b)&&b>a?(b-a)/60000:null;
}
function normalizar(s){
  return typeof s==="string" ? s.normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ") : "";
}
function contem(texto,s,min){
  const a=normalizar(s),b=normalizar(texto);
  return a.length>=min&&(" "+b+" ").includes(" "+a+" ");
}
function exact(desc,legacy){
  return typeof desc==="string"&&/^evt_[A-Za-z0-9_-]{1,128}$/.test(legacy)&&
    new RegExp("(^|[^A-Za-z0-9_-])"+legacy+"(?=$|[^A-Za-z0-9_-])").test(desc);
}
function iniciarDia(d){return d+"T00:00:00-03:00";}
function proximoDia(d){return new Date(Date.parse(d+"T12:00:00Z")+86400000).toISOString().slice(0,10);}
function desejadoUTC(t){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t))erro("DATA_DESEJADA_INVALIDA");
  return Date.parse(t+":00-03:00");
}
function resumoSemDados(items){
  return items.map(x=>({
    caso:x.caso.codigo,
    origemGoogle:local(x.event.start.dateTime),
    destinoFirestore:x.inicioFirestore,
    duracaoGoogle:minutos(x.event),
    duracaoFirestore:x.duracaoFirestore,
    operacao:x.caso.codigo==="21DEZ"?"MOVER_MESMO_EVENTO":"APENAS_VINCULAR",
  }));
}
function validarMarcador(ev,row,fs){
  if(!ev||ev.status!=="confirmed"||ev.recurringEventId||
     !/^[A-Za-z0-9_-]{5,1024}$/.test(ev.id||"")||!ev.etag||
     !exact(ev.description,row.event_id))erro("EVENTO_LEGADO_INAPTO");
  if(fs.calendarEventId!==row.event_id)erro("REFERENCIA_FIRESTORE_DIVERGENTE");
  if(!["confirmado","reagendado","agendado"].includes(normalizar(fs.status)))
    erro("FIRESTORE_NAO_ATIVO");
  if(!contem(ev.summary,fs.nomeCliente,5)||!contem(ev.summary,fs.servico,4))
    erro("IDENTIDADE_SERVICO_DIVERGENTE");
  if(!contem(ev.summary,row.nome_cliente,5))erro("NOME_OUTBOX_DIVERGENTE");
}
async function lerBanco(pool){
  const conn=await pool.connect(),rows=[];
  try{
    await conn.query("BEGIN TRANSACTION READ ONLY");
    const total=(await conn.query(
      "SELECT COUNT(*)::integer AS n FROM public.google_calendar_event_links"
    )).rows[0].n;
    if(total!==111)erro("TOTAL_VINCULOS_INESPERADO");
    for(const c of CASOS){
      const q=await conn.query(
        "SELECT agendamento_id,event_id,status,nome_cliente,servico,"+
        "TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso,"+
        "TO_CHAR(horario,'HH24:MI') AS hora_iso,duracao_minutos "+
        "FROM public.pix_calendar_outbox WHERE data_servico=$1::date "+
        "AND horario=$2::time",[c.dia,c.hora]);
      if(q.rows.length!==1||q.rows[0].status!=="enviado"||
         q.rows[0].event_id!=="evt_"+q.rows[0].agendamento_id)
        erro("OUTBOX_AMBIGUA_"+c.codigo);
      const row=q.rows[0];
      const [links,ops,canc]=[
        await conn.query("SELECT 1 FROM public.google_calendar_event_links WHERE agendamento_id=$1",
          [row.agendamento_id]),
        await conn.query("SELECT 1 FROM public.google_calendar_sync_operations "+
          "WHERE agendamento_id=$1 AND estado IN "+
          "('pendente','processando','aguardando_confirmacao','conflito')",
          [row.agendamento_id]),
        await conn.query("SELECT 1 FROM public.agendamento_cancelamentos WHERE agendamento_id=$1",
          [row.agendamento_id]),
      ];
      if(links.rows.length||ops.rows.length||canc.rows.length)
        erro("REGISTRO_NAO_ELEGIVEL_"+c.codigo);
      rows.push({caso:c,row});
    }
    const glob=await conn.query(
      "SELECT COUNT(*)::integer AS n FROM public.google_calendar_sync_operations "+
      "WHERE estado IN ('pendente','processando','aguardando_confirmacao','conflito')");
    if(glob.rows[0].n!==0)erro("OPERACOES_GOOGLE_PENDENTES");
    await conn.query("COMMIT");
    return rows;
  }catch(e){await conn.query("ROLLBACK").catch(()=>{});throw e;}
  finally{conn.release();}
}
async function buscarPares(pool,google,db,inputs,cfg){
  const resultados=[];
  for(const {caso,row} of inputs){
    const snap=await db.collection("agendamentos").doc(row.agendamento_id).get();
    if(!snap.exists)erro("FIRESTORE_AUSENTE_"+caso.codigo);
    const fs=snap.data();
    const start=String(fs.data||"")+"T"+String(fs.horario||"").slice(0,5);
    const dur=Number(fs.duracaoSnapshot??fs.duracao??fs.duracaoMinutos);
    if(start!==caso.inicioEsperado||dur!==caso.duracao)
      erro("FIRESTORE_ALTERADO_"+caso.codigo);
    const lista=await google.listarEventos({
      inicio:iniciarDia(caso.dia),fim:iniciarDia(proximoDia(caso.dia)),
      incluirDescricao:true,
    });
    if(!lista.completo)erro("GOOGLE_LISTAGEM_PARCIAL");
    const encontrados=lista.eventos.filter(ev=>exact(ev.description,row.event_id));
    if(encontrados.length!==1)erro("MARCADOR_NAO_UNICO_"+caso.codigo);
    const event=encontrados[0];
    validarMarcador(event,row,fs);
    if(minutos(event)!==dur)erro("DURACAO_ATUAL_DIVERGENTE_"+caso.codigo);
    const from=local(event.start?.dateTime);
    if(from!==caso.dia+"T"+caso.hora)erro("ORIGEM_GOOGLE_MUDOU_"+caso.codigo);
    if(caso.codigo!=="21DEZ"&&from!==start)erro("HORARIO_DIVERGENTE_"+caso.codigo);
    const another=await pool.query(
      "SELECT 1 FROM public.google_calendar_event_links WHERE "+
      "(calendar_id=$1 AND google_event_id=$2) OR agendamento_id=$3 LIMIT 1",
      [cfg.calendarId,event.id,row.agendamento_id]);
    if(another.rows.length)erro("LINK_JA_PRESENTE_"+caso.codigo);
    resultados.push({caso,row,fs,event,inicioFirestore:start,duracaoFirestore:dur});
  }
  // Verificar ocupacao de 22/12 no proprio Google e no Firestore, sem comparar
  // somente o horario de inicio (intervalos de duracao real).
  const move=resultados[2],dest=move.caso.inicioEsperado;
  const destInicio=desejadoUTC(dest),destFim=destInicio+move.duracaoFirestore*60000;
  const eventosDestino=await google.listarEventos({
    inicio:iniciarDia("2026-12-22"),fim:iniciarDia("2026-12-23"),
    incluirDescricao:false,
  });
  if(!eventosDestino.completo)erro("DESTINO_GOOGLE_INCOMPLETO");
  for(const e of eventosDestino.eventos){
    if(e.status==="cancelled"||e.id===move.event.id)continue;
    // Evento de dia inteiro cobre o expediente: nunca o ignorar.
    if(e.start?.date&&!e.start?.dateTime)erro("DESTINO_GOOGLE_DIA_INTEIRO");
    const ini=Date.parse(e.start?.dateTime),fim=Date.parse(e.end?.dateTime);
    if(!Number.isFinite(ini)||!Number.isFinite(fim))erro("DESTINO_GOOGLE_EVENTO_INDEFINIDO");
    if(destInicio<fim&&ini<destFim)erro("DESTINO_GOOGLE_OCUPADO");
  }
  const agenda=await db.collection("agendamentos").where("data","==","2026-12-22").limit(500).get();
  if(agenda.size>=500)erro("DESTINO_FIRESTORE_INCOMPLETO");
  for(const doc of agenda.docs){
    if(doc.id===move.row.agendamento_id)continue;
    const d=doc.data()||{};
    if(!["agendado","reagendado","confirmado"].includes(normalizar(d.status)))continue;
    const t=Date.parse(String(d.data||"")+"T"+String(d.horario||"").slice(0,5)+":00-03:00");
    const dur=Number(d.duracaoSnapshot??d.duracao??d.duracaoMinutos);
    if(!Number.isFinite(t)||!Number.isFinite(dur)||dur<=0)erro("DESTINO_FIRESTORE_INDEFINIDO");
    if(destInicio<t+dur*60000&&t<destFim)erro("DESTINO_FIRESTORE_OCUPADO");
  }
  const pgConf=await pool.query(
    "SELECT COUNT(*)::integer AS n FROM public.pix_reservas "+
    "WHERE data_servico=$1::date AND estado IN ('reservada','confirmada') "+
    "AND agendamento_id IS DISTINCT FROM $2 "+
    "AND inicio_minuto < $4 AND fim_minuto > $3",
    ["2026-12-22",move.row.agendamento_id,420,510]);
  if(pgConf.rows[0].n!==0)erro("DESTINO_POSTGRES_OCUPADO");
  return resultados;
}
async function gravarVinculos(pool,pairs,cfg){
  const conn=await pool.connect();
  try{
    await conn.query("BEGIN");
    await conn.query("SET LOCAL lock_timeout='5s'");
    await conn.query("SET LOCAL statement_timeout='25s'");
    const total=await conn.query("SELECT COUNT(*)::integer AS n FROM public.google_calendar_event_links");
    if(total.rows[0].n!==111)erro("TOTAL_VINCULOS_MUDOU");
    for(const x of pairs){
      const r=await conn.query(
        "SELECT status,event_id FROM public.pix_calendar_outbox "+
        "WHERE agendamento_id=$1 FOR UPDATE",[x.row.agendamento_id]);
      if(r.rows.length!==1||r.rows[0].status!=="enviado"||
         r.rows[0].event_id!==x.row.event_id)erro("OUTBOX_MUDOU");
      const c=await conn.query(
        "SELECT 1 FROM public.agendamento_cancelamentos WHERE agendamento_id=$1",
        [x.row.agendamento_id]);
      if(c.rows.length)erro("CANCELAMENTO_NOVO");
      const ops=await conn.query(
        "SELECT 1 FROM public.google_calendar_sync_operations "+
        "WHERE agendamento_id=$1 AND estado IN "+
        "('pendente','processando','aguardando_confirmacao','conflito')",
        [x.row.agendamento_id]);
      if(ops.rows.length)erro("OPERACAO_NOVA");
    }
    const saved=await conn.query(
      "INSERT INTO public.google_calendar_event_links "+
      "(agendamento_id,calendar_id,google_event_id,origem,metodo_verificacao,"+
      "verificado_em,verificado_por) "+
      "SELECT d.agendamento_id,$4,d.google_event_id,'legado_validado',"+
      "'revisao_manual_confirmada',NOW(),'conciliacao-excecoes-20261109' "+
      "FROM UNNEST($1::text[],$2::text[],$3::text[]) "+
      "AS d(agendamento_id,google_event_id,legacy_event_id) "+
      "JOIN public.pix_calendar_outbox o ON o.agendamento_id=d.agendamento_id "+
      "AND o.event_id=d.legacy_event_id AND o.status='enviado' "+
      "WHERE NOT EXISTS (SELECT 1 FROM public.agendamento_cancelamentos c "+
      "WHERE c.agendamento_id=d.agendamento_id) "+
      "ON CONFLICT DO NOTHING RETURNING agendamento_id",
      [pairs.map(x=>x.row.agendamento_id),pairs.map(x=>x.event.id),
        pairs.map(x=>x.row.event_id),cfg.calendarId]);
    if(saved.rowCount!==3)erro("LINKS_NAO_INSERIDOS");
    await conn.query("COMMIT");
  }catch(e){await conn.query("ROLLBACK").catch(()=>{});throw e;}
  finally{conn.release();}
}

const env=process.env;
const flag="GOOGLE_CALENDAR_CORRECAO_TRES_APROVADA";
const args=process.argv.slice(2);
const aplicar=args.length===1&&args[0]==="--apply";
if(!(args.length===0||aplicar))erro("ARGUMENTOS_INVALIDOS");
if(env.GOOGLE_CALENDAR_OAUTH_ENABLED!=="true"||
   env.GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED==="true"||
   env.GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED==="true"||
   env.GOOGLE_CALENDAR_AUDIT_ENABLED!=="true"||
   env.GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED==="true"||
   (aplicar&&(env[flag]!=="true"||env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED!=="true"))||
   (!aplicar&&env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED==="true")){
  erro("MODO_ESCRITA_INCORRETO");
}
let pool;
try{
  const cfg=configuracaoCalendarOAuth(env);
  pool=new pg.Pool({max:2,connectionTimeoutMillis:10000});
  const google=criarAdaptadorGoogleCalendarComOAuth(pool,{env});
  if(!getApps().length)initializeApp({
    credential:applicationDefault(),projectId:"isabele-nails-app",
  });
  const db=getFirestore(),inputs=await lerBanco(pool);
  const pares=await buscarPares(pool,google,db,inputs,cfg);
  const evidencia=createHash("sha256").update(JSON.stringify(pares.map(x=>({
    eventoId:x.event.id,etag:x.event.etag,
    agendamentoId:x.row.agendamento_id,legacy:x.row.event_id,
    inicioLocal:x.inicioFirestore,duracao:x.duracaoFirestore,
  })))).digest("hex");
  console.log(JSON.stringify({resultado:aplicar?"VERIFICACAO_APLICACAO":"PREVIA_CONFERIDA",
    casos:resumoSemDados(pares),conflitosDestino:0,identidadesConfirmadas:3,
    hashEvidencia:evidencia,alteracaoPendente:aplicar},null,2));
  if(aplicar){
    const patch=pares[2],start=desejadoUTC(patch.inicioFirestore);
    // Formato ISO sem milissegundos tambem compativel com a imagem staging anterior.
    const expectedEnd=new Date(start+patch.duracaoFirestore*60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const payload={
      agendamentoId:patch.row.agendamento_id,eventId:patch.event.id,
      legacyEventId:patch.row.event_id,
      nomeCliente:patch.fs.nomeCliente,servico:patch.fs.servico,
      inicio:patch.inicioFirestore+":00-03:00",fim:expectedEnd,
      inicioAnterior:patch.caso.dia+"T"+patch.caso.hora+":00-03:00",
    };
    // Atualizar SOMENTE o evento antigo, nunca criar ou cancelar.
    await google.atualizarEventoLegado(payload);
    const atual=await google.consultarEventoLegado({eventId:patch.event.id});
    if(!atual||atual.status!=="confirmed"||
       !exact(atual.description,patch.row.event_id)||
       local(atual.start?.dateTime)!==patch.inicioFirestore||
       minutos(atual)!==patch.duracaoFirestore||
       !contem(atual.summary,patch.fs.nomeCliente,5)||
       !contem(atual.summary,patch.fs.servico,4)){
      erro("PATCH_GOOGLE_NAO_CONFIRMADO");
    }
    // O Firestore pode ter mudado entre a previa e o PATCH. Neste caso nao
    // registrar vinculos e pedir reconciliacao manual; nunca regravar Google.
    for(const pair of pares){
      const doc=await db.collection("agendamentos").doc(pair.row.agendamento_id).get();
      const d=doc.exists?doc.data():null;
      if(!d||String(d.data)+"T"+String(d.horario).slice(0,5)!==pair.inicioFirestore||
         Number(d.duracaoSnapshot??d.duracao??d.duracaoMinutos)!==pair.duracaoFirestore||
         d.calendarEventId!==pair.row.event_id)
        erro("FIRESTORE_MUDOU_APOS_PATCH");
    }
    await gravarVinculos(pool,pares,cfg);
    console.log(JSON.stringify({resultado:"TRES_CASOS_CONCLUIDOS",
      vinculacoesNovas:3,eventoExistenteMovido:true,
      anterior:"2026-12-21 07:00",atual:"2026-12-22 07:00",
      duracaoMinutos:90,googleEventosCriados:0,googleEventosCancelados:0,
      firestoreAlterado:false,pixAlterado:false}));
  }
}catch(e){
  console.error("CORRECAO_TRES_BLOQUEADA:",e.codigo||"ERRO_NAO_CONFIRMADO");
  process.exitCode=1;
}finally{if(pool)await pool.end().catch(()=>{});}
