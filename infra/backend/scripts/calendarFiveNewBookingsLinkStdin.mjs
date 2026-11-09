/**
 * Cutover: registrar SOMENTE os cinco agendamentos criados durante a migracao.
 * Execucao via stdin dentro da API atual, sem rede para escrita no Google.
 * Compara referencia exata, evento real, horario, duracao, identidade, Firestore
 * e PostgreSQL. Nao altera Google, Firestore, PIX nem horarios.
 * Falha se houver nova reserva, exclusao, alteracao, concorrencia ou conflito.
 */
import pg from "pg";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { criarAdaptadorGoogleCalendarComOAuth } from "/app/src/googleCalendarTokenProvider.js";
import { prepararCandidatosLegados } from "/app/src/googleCalendarLegacyCandidates.js";
import { configuracaoCalendarOAuth } from "/app/src/googleCalendarOAuth.js";

const DIAS=["2026-11-13","2026-11-21","2026-12-05","2026-12-14","2026-12-22"];
const aplicar=process.argv.length===3 && process.argv[2]==="--apply";
const env=process.env;
function bloquear(codigo){throw Object.assign(new Error(codigo),{codigo});}
function proximoDia(d){return new Date(Date.parse(d+"T12:00:00Z")+86400000).toISOString().slice(0,10);}
function fingerprint(d){
  return JSON.stringify({
    data:d?.data,horario:d?.horario,duracaoSnapshot:d?.duracaoSnapshot,
    duracao:d?.duracao,duracaoMinutos:d?.duracaoMinutos,
    calendarEventId:d?.calendarEventId,status:d?.status,
    nomeCliente:d?.nomeCliente,servico:d?.servico,
  });
}
function equalEvent(a,b){
  return !!a&&!!b&&["id","etag","summary","description","status","recurringEventId"]
    .every(k=>a[k]===b[k])&&
    a.start?.dateTime===b.start?.dateTime&&a.end?.dateTime===b.end?.dateTime;
}
function normalizar(v){
  return typeof v==="string" ? v.normalize("NFD").replace(/[\\u0300-\\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim().replace(/\\s+/g," ") : "";
}
function contem(titulo,valor,min){
  const v=normalizar(valor), t=normalizar(titulo);
  return v.length>=min && (" "+t+" ").includes(" "+v+" ");
}
if((process.argv.length!==2&&!aplicar)||
  (aplicar&&env.GOOGLE_CALENDAR_CINCO_RECENTES_APROVADO!=="true")||
  env.GOOGLE_CALENDAR_OAUTH_ENABLED!=="true"||
  env.GOOGLE_CALENDAR_AUDIT_ENABLED!=="true"||
  env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED==="true"||
  env.GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED==="true"||
  env.GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED==="true"||
  env.GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED==="true")bloquear("MODO_CINCO_INCORRETO");

let pool,conn;
try{
  const cfg=configuracaoCalendarOAuth(env);
  pool=new pg.Pool({max:2,connectionTimeoutMillis:10000});
  const google=criarAdaptadorGoogleCalendarComOAuth(pool,{env});
  if(!getApps().length)initializeApp({credential:applicationDefault(),projectId:"isabele-nails-app"});
  const db=getFirestore();
  const [q,linked,ops,existing] = await Promise.all([
    pool.query("SELECT agendamento_id,event_id,status,nome_cliente,servico,"+
      "TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso,"+
      "TO_CHAR(horario,'HH24:MI') AS hora_iso,duracao_minutos "+
      "FROM public.pix_calendar_outbox o "+
      "WHERE status='enviado' AND data_servico>=CURRENT_DATE "+
      "AND NOT EXISTS (SELECT 1 FROM public.google_calendar_event_links l WHERE l.agendamento_id=o.agendamento_id) "+
      "AND NOT EXISTS (SELECT 1 FROM public.agendamento_cancelamentos c WHERE c.agendamento_id=o.agendamento_id "+
      "AND c.estado IN ('concluida','solicitada')) "+
      "ORDER BY data_servico,horario,agendamento_id LIMIT 21"),
    pool.query("SELECT COUNT(*)::integer AS n FROM public.google_calendar_event_links"),
    pool.query("SELECT COUNT(*)::integer AS n FROM public.google_calendar_sync_operations "+
      "WHERE estado IN ('pendente','processando','aguardando_confirmacao','conflito')"),
    pool.query("SELECT agendamento_id,google_event_id,origem,metodo_verificacao,calendar_id "+
      "FROM public.google_calendar_event_links WHERE calendar_id=$1 LIMIT 4001",[cfg.calendarId])
  ]);
  if(linked.rows[0].n!==114)bloquear("CONTAGEM_INICIAL_NAO_114");
  if(ops.rows[0].n!==0)bloquear("OPERACOES_GOOGLE_PENDENTES");
  if(existing.rows.length!==114)bloquear("VINCULOS_DE_OUTRO_CALENDARIO_OU_LIMITE");
  const rows=q.rows;
  if(rows.length!==5)bloquear("QUANTIDADE_RECENTES_ALTERADA");
  if(rows.some(r=>r.status!=="enviado"||r.event_id!=="evt_"+r.agendamento_id)||
    rows.map(r=>r.data_iso).sort().join("|")!==DIAS.join("|"))
    bloquear("DATAS_OU_REFERENCIAS_DIVERGENTES");
  const ids=rows.map(r=>r.agendamento_id);
  const cancel=await pool.query("SELECT agendamento_id FROM public.agendamento_cancelamentos "+
    "WHERE agendamento_id=ANY($1::text[]) LIMIT 1",[ids]);
  if(cancel.rows.length)bloquear("CANCELAMENTO_EXISTENTE");
  const firestore=[];
  for(const row of rows){
    const snap=await db.collection("agendamentos").doc(row.agendamento_id).get();
    if(!snap.exists)bloquear("FIRESTORE_AUSENTE");
    firestore.push({...snap.data(),id:snap.id});
  }
  const eventos=[];
  for(const d of DIAS){
    const result=await google.listarEventos({
      inicio:d+"T00:00:00-03:00",
      fim:proximoDia(d)+"T00:00:00-03:00",
      incluirDescricao:true
    });
    if(!result.completo)bloquear("LISTAGEM_GOOGLE_INCOMPLETA");
    eventos.push(...result.eventos);
  }
  const review=prepararCandidatosLegados({
    outbox:rows,firestore,eventos,cancelamentos:[],
    vinculos:existing.rows,calendarId:cfg.calendarId
  });
  if(review.candidatos.length!==5||review.revisoes.length!==0){
    console.log(JSON.stringify({resultado:"CONCILIACAO_CINCO_REQUER_REVISAO",
      candidatos:review.candidatos.length,motivos:review.resumo.excecoes}));
    bloquear("IDENTIDADES_OU_HORARIOS_DIVERGENTES");
  }
  const indexed=new Map(eventos.map(e=>[e.id,e]));
  const fsMap=new Map(firestore.map(x=>[x.id,x]));
  for(const cand of review.candidatos){
    const ev=indexed.get(cand.googleEventId), fs=fsMap.get(cand.agendamentoId);
    if(!contem(ev?.summary,fs?.nomeCliente,5)||!contem(ev?.summary,fs?.servico,4))
      bloquear("IDENTIDADE_FIRESTORE_GOOGLE_DIVERGENTE");
  }
  const sig=createHash("sha256").update(review.candidatos
    .map(x=>x.fingerprintEvidencia).sort().join("\n")).digest("hex");
  console.log(JSON.stringify({resultado:aplicar?"VERIFICACAO_APLICACAO":"PREVIA_CONFERIDA",
    datas:DIAS,identidadesConfirmadas:5,conflitosDeVinculo:0,
    hashEvidencia:sig,alteracaoPendente:aplicar},null,2));
  if(!aplicar){
    console.log("SOMENTE_LEITURA_NENHUM_VINCULO_GRAVADO");
  } else {
    for(const cand of review.candidatos){
      const current=await google.consultarEventoLegado({eventId:cand.googleEventId});
      if(!equalEvent(current,indexed.get(cand.googleEventId)))bloquear("GOOGLE_MUDOU_DESDE_PREVIA");
      const snap=await db.collection("agendamentos").doc(cand.agendamentoId).get();
      if(!snap.exists||fingerprint(snap.data())!==fingerprint(fsMap.get(cand.agendamentoId)))
        bloquear("FIRESTORE_MUDOU_DESDE_PREVIA");
    }
    conn=await pool.connect();
    await conn.query("BEGIN");
    try{
      await conn.query("SET LOCAL lock_timeout='5s'");
      await conn.query("SET LOCAL statement_timeout='25s'");
      const count=await conn.query("SELECT COUNT(*)::integer AS n FROM public.google_calendar_event_links");
      if(count.rows[0].n!==114)bloquear("VINCULOS_MUDARAM");
      for(const row of rows){
        const chk=await conn.query("SELECT event_id,status,nome_cliente,servico,"+
          "TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso,"+
          "TO_CHAR(horario,'HH24:MI') AS hora_iso,duracao_minutos "+
          "FROM public.pix_calendar_outbox WHERE agendamento_id=$1 FOR UPDATE",[row.agendamento_id]);
        const r=chk.rows[0];
        if(chk.rows.length!==1||!r||
          ["event_id","status","nome_cliente","servico","data_iso","hora_iso"].some(k=>r[k]!==row[k])||
          Number(r.duracao_minutos)!==Number(row.duracao_minutos))bloquear("OUTBOX_MUDOU");
        const c=await conn.query("SELECT 1 FROM public.agendamento_cancelamentos WHERE agendamento_id=$1 LIMIT 1",[row.agendamento_id]);
        if(c.rows.length)bloquear("CANCELAMENTO_NOVO");
        const op=await conn.query("SELECT 1 FROM public.google_calendar_sync_operations WHERE agendamento_id=$1 "+
          "AND estado IN ('pendente','processando','aguardando_confirmacao','conflito') LIMIT 1",[row.agendamento_id]);
        if(op.rows.length)bloquear("OPERACAO_NOVA");
      }
      const saved=await conn.query(
        "INSERT INTO public.google_calendar_event_links "+
        "(agendamento_id,calendar_id,google_event_id,origem,metodo_verificacao,verificado_em,verificado_por) "+
        "SELECT x.agendamento_id,$4,x.google_event_id,'legado_validado','revisao_manual_confirmada',"+
        "NOW(),'conciliacao-cinco-recentes-20261109' "+
        "FROM UNNEST($1::text[],$2::text[],$3::text[]) "+
        "AS x(agendamento_id,google_event_id,legacy_event_id) "+
        "JOIN public.pix_calendar_outbox o ON o.agendamento_id=x.agendamento_id "+
        "AND o.event_id=x.legacy_event_id AND o.status='enviado' "+
        "WHERE NOT EXISTS (SELECT 1 FROM public.agendamento_cancelamentos c WHERE c.agendamento_id=x.agendamento_id) "+
        "ON CONFLICT DO NOTHING RETURNING agendamento_id",
        [review.candidatos.map(x=>x.agendamentoId),review.candidatos.map(x=>x.googleEventId),
          review.candidatos.map(x=>x.legacyEventId),cfg.calendarId]
      );
      if(saved.rowCount!==5)bloquear("GRAVACAO_INCOMPLETA");
      const final=await conn.query("SELECT COUNT(*)::integer AS n FROM public.google_calendar_event_links");
      if(final.rows[0].n!==119)bloquear("TOTAL_FINAL_INESPERADO");
      await conn.query("COMMIT");
      console.log(JSON.stringify({resultado:"CINCO_RECENTES_VINCULADOS",
        inseridos:5,totalVinculos:119,eventosGoogleAlterados:0,firestoreAlterado:false,pixAlterado:false}));
    }catch(e){await conn.query("ROLLBACK").catch(()=>{});throw e;}
    finally{conn.release();conn=null;}
  }
}catch(e){
  console.error("CONCILIACAO_CINCO_BLOQUEADA:",e.codigo||"ERRO_NAO_CONFIRMADO");
  process.exitCode=1;
}finally{
  if(conn)conn.release();
  if(pool)await pool.end().catch(()=>{});
}
