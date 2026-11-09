/**
 * Auditoria privada SOMENTE LEITURA das 3 excecoes conhecidas do cutover.
 *
 * Entradas: outbox (PG), Firestore e eventos existentes no Google Calendar.
 * Nao grava links nem modifica Google/PIX/Firestore/PG. Nao imprime nomes,
 * servicos, agendamentoId, calendarId, eventId ou descricoes de clientes.
 *
 * Executar por stdin dentro da API com as flags diretas explicitamente off.
 * Uso: node --input-type=module -
 */
import pg from "pg";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  configuracaoCalendarOAuth, descriptografarCalendarToken,
} from "/app/src/googleCalendarOAuth.js";

const CASOS = Object.freeze([
  { rotulo: "14/11/2026 09:00", data: "2026-11-14", hora: "09:00" },
  { rotulo: "10/12/2026 11:00", data: "2026-12-10", hora: "11:00" },
  { rotulo: "21/12/2026 07:00", data: "2026-12-21", hora: "07:00" },
]);
const FUSO = "America/Sao_Paulo";
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO, hourCycle: "h23", year: "numeric",
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function falhar(codigo) {
  throw Object.assign(new Error(codigo), { codigo });
}
function horaLocal(iso) {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return null;
  const parts = Object.fromEntries(fmt.formatToParts(new Date(iso))
    .filter(p => ["year","month","day","hour","minute"].includes(p.type))
    .map(p => [p.type,p.value]));
  return parts.year+"-"+parts.month+"-"+parts.day+"T"+parts.hour+":"+parts.minute;
}
function duracao(evento) {
  const a=Date.parse(evento?.start?.dateTime);
  const b=Date.parse(evento?.end?.dateTime);
  return Number.isFinite(a) && Number.isFinite(b) && b>a
    ? (b-a)/60000 : null;
}
function normalizar(txt) {
  return typeof txt === "string"
    ? txt.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()
      .replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ")
    : "";
}
function contem(titulo,valor,min) {
  const sub=normalizar(valor),whole=normalizar(titulo);
  return sub.length>=min && (" "+whole+" ").includes(" "+sub+" ");
}
function marcador(descricao,ref) {
  if(typeof descricao!=="string"||!/^evt_[A-Za-z0-9_-]{1,128}$/.test(ref))return false;
  return new RegExp("(^|[^A-Za-z0-9_-])"+ref+"(?=$|[^A-Za-z0-9_-])").test(descricao);
}
async function pedir(url,init={}) {
  const resp=await fetch(url,{...init,signal:AbortSignal.timeout(18000)});
  if(!resp.ok)falhar("GOOGLE_HTTP_"+resp.status);
  return resp.json();
}
async function listarDia(accessToken,cfg,data) {
  const ate=new Date(Date.parse(data+"T12:00:00Z")+86400000)
    .toISOString().slice(0,10);
  const found=[],tokens=new Set();
  let next="";
  for(let i=0;i<10;i++) {
    const u=new URL("https://www.googleapis.com/calendar/v3/calendars/"+
      encodeURIComponent(cfg.calendarId)+"/events");
    u.searchParams.set("timeMin",data+"T00:00:00-03:00");
    u.searchParams.set("timeMax",ate+"T00:00:00-03:00");
    u.searchParams.set("singleEvents","true");
    u.searchParams.set("showDeleted","false");
    u.searchParams.set("maxResults","250");
    u.searchParams.set("fields",
      "kind,nextPageToken,items(id,status,etag,summary,description,"+
      "start(dateTime),end(dateTime),recurringEventId,extendedProperties(private))");
    if(next)u.searchParams.set("pageToken",next);
    const res=await pedir(u,{headers:{Authorization:"Bearer "+accessToken}});
    if(res.kind!=="calendar#events"||!Array.isArray(res.items))falhar("GOOGLE_LISTA_INVALIDA");
    found.push(...res.items);
    if(found.length>1500)falhar("LIMITE_GOOGLE");
    if(!res.nextPageToken)return found;
    if(tokens.has(res.nextPageToken))falhar("PAGINACAO_REPETIDA");
    tokens.add(res.nextPageToken);next=res.nextPageToken;
  }
  falhar("PAGINACAO_INCOMPLETA");
}
function statusPermitido(valor) {
  return ["confirmado","reagendado","agendado","concluido","concluida",
    "finalizado","finalizada","realizado","realizada","atendido","atendida"]
      .includes(normalizar(valor));
}

let pool;
try {
  for(const name of [
    "GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED",
    "GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED",
  ])if(process.env[name]==="true")falhar("FLAG_ESCRITA_ATIVA");
  if(process.env.GOOGLE_CALENDAR_OAUTH_ENABLED!=="true")falhar("OAUTH_INATIVO");
  const cfg=configuracaoCalendarOAuth();
  pool=new pg.Pool({max:1,connectionTimeoutMillis:10000});
  const conexao=await pool.connect();
  const registros=[];
  let credencial;
  try {
    await conexao.query("BEGIN TRANSACTION READ ONLY");
    credencial=(await conexao.query(
      "SELECT google_email,refresh_token_encrypted "+
      "FROM public.google_calendar_oauth_credentials WHERE connection_name='isabele'"
    )).rows[0];
    for(const item of CASOS) {
      const q=await conexao.query(
        "SELECT agendamento_id,event_id,status,nome_cliente,servico,"+
        "TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso,"+
        "TO_CHAR(horario,'HH24:MI') AS hora_iso,duracao_minutos "+
        "FROM public.pix_calendar_outbox WHERE data_servico=$1::date "+
        "AND TO_CHAR(horario,'HH24:MI')=$2",
        [item.data,item.hora],
      );
      if(q.rows.length!==1 || q.rows[0].status!=="enviado")
        falhar("OUTBOX_NAO_UNICA_"+item.data);
      const row=q.rows[0];
      if(row.event_id!=="evt_"+row.agendamento_id)
        falhar("REFERENCIA_LEGADA_INVALIDA_"+item.data);
      const [cancel,links,operacoes]=await Promise.all([
        conexao.query("SELECT estado FROM public.agendamento_cancelamentos "+
          "WHERE agendamento_id=$1",[row.agendamento_id]),
        conexao.query("SELECT google_event_id FROM public.google_calendar_event_links "+
          "WHERE agendamento_id=$1",[row.agendamento_id]),
        conexao.query("SELECT estado FROM public.google_calendar_sync_operations "+
          "WHERE agendamento_id=$1 AND estado IN "+
          "('pendente','processando','aguardando_confirmacao','conflito')",
          [row.agendamento_id]),
      ]);
      if(cancel.rows.length || links.rows.length || operacoes.rows.length)
        falhar("CONFLITO_NO_BANCO_"+item.data);
      registros.push({...item,row});
    }
    await conexao.query("COMMIT");
  }catch(e){await conexao.query("ROLLBACK").catch(()=>{});throw e;}
  finally{conexao.release();}

  if(credencial?.google_email?.trim().toLowerCase()!==cfg.expectedEmail)
    falhar("CONTA_GOOGLE_DIVERGENTE");
  const refresh=descriptografarCalendarToken(credencial.refresh_token_encrypted,cfg.key);
  const token=await pedir("https://oauth2.googleapis.com/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh,
      client_id:cfg.clientId,client_secret:cfg.clientSecret}),
  });
  if(typeof token.access_token!=="string" || !token.access_token)
    falhar("TOKEN_GOOGLE_INDISPONIVEL");
  if(token.refresh_token && token.refresh_token !== refresh)
    falhar("TOKEN_GOOGLE_ROTACIONADO_CONFERIR_OAUTH");
  const user=await pedir("https://openidconnect.googleapis.com/v1/userinfo",{
    headers:{Authorization:"Bearer "+token.access_token},
  });
  if(user.email_verified!==true||user.email?.trim().toLowerCase()!==cfg.expectedEmail)
    falhar("IDENTIDADE_GOOGLE_DIVERGENTE");
  if(!getApps().length)initializeApp({
    credential:applicationDefault(),projectId:"isabele-nails-app",
  });
  const db=getFirestore();
  const relatorio=[];
  for(const {rotulo,data,hora,row} of registros) {
    const [docSnap,eventos]=await Promise.all([
      db.collection("agendamentos").doc(row.agendamento_id).get(),
      listarDia(token.access_token,cfg,data),
    ]);
    const matches=eventos.filter(e=>marcador(e.description,row.event_id));
    if(matches.length!==1)falhar("MARCADORES_NAO_UNICOS_"+data);
    const ev=matches[0];
    if(typeof ev.id!=="string"||!/^[A-Za-z0-9_-]{5,1024}$/.test(ev.id))
      falhar("GOOGLE_ID_INVALIDO_"+data);
    if(ev.status!=="confirmed" || ev.recurringEventId || !ev.etag)
      falhar("GOOGLE_EVENTO_INAPTO_"+data);
    const other=await pool.query(
      "SELECT 1 FROM public.google_calendar_event_links "+
      "WHERE calendar_id=$1 AND google_event_id=$2 LIMIT 1",
      [cfg.calendarId,ev.id],
    );
    if(other.rows.length)falhar("EVENTO_GOOGLE_JA_VINCULADO_"+data);
    const fs=docSnap.exists?docSnap.data():null;
    const googleInicio=horaLocal(ev.start?.dateTime);
    const googleDur=duracao(ev);
    if(!googleInicio||!googleDur)falhar("INTERVALO_GOOGLE_INVALIDO_"+data);
    const fsInicio=fs ? String(fs.data||"")+"T"+String(fs.horario||"").slice(0,5):null;
    const fsDuracao=fs ? Number(fs.duracaoSnapshot??fs.duracao??fs.duracaoMinutos):null;
    relatorio.push({
      caso:rotulo,
      calendarioCorreto:true,
      marcadorExatoUnico:true,
      eventoGoogleConfirmado:true,
      firestoreExiste:!!fs,
      firestoreStatus:typeof fs?.status==="string"?normalizar(fs.status):"ausente",
      firestoreStatusPermiteRevisao:statusPermitido(fs?.status),
      referenciaFirestoreCorresponde:fs?.calendarEventId===row.event_id,
      inicio:{
        registroOriginal:row.data_iso+" "+row.hora_iso,
        firestore:fsInicio?.replace("T"," ")||null,
        google:googleInicio.replace("T"," "),
        firestoreIgualGoogle:fsInicio===googleInicio,
      },
      duracaoMinutos:{
        registroOriginal:Number(row.duracao_minutos),
        firestore:Number.isFinite(fsDuracao)?fsDuracao:null,
        google:googleDur,
        firestoreIgualGoogle:fsDuracao===googleDur,
      },
      verificacaoTitulo:{
        nomeOutboxNoGoogle:contem(ev.summary,row.nome_cliente,5),
        servicoOutboxNoGoogle:contem(ev.summary,row.servico,4),
        nomeFirestoreNoGoogle:contem(ev.summary,fs?.nomeCliente,5),
        servicoFirestoreNoGoogle:contem(ev.summary,fs?.servico,4),
      },
      vinculoExistente:false,
      dadosDeClientesImpressos:false,
      conclusao:"REVISAO_MANUAL_NECESSARIA",
    });
  }
  console.log(JSON.stringify({
    modo:"SOMENTE_LEITURA",
    casos:relatorio,
    eventosCriadosOuAlterados:0,
    vinculosInseridos:0,
    proximoPasso:"Confirmar divergencias com dados atuais antes de qualquer vinculacao.",
  },null,2));
}catch(error){
  console.error("REVISAO_EXCECOES_FALHOU:",error.codigo||"FONTE_INDISPONIVEL");
  process.exitCode=1;
}finally{
  if(pool)await pool.end().catch(()=>{});
}
