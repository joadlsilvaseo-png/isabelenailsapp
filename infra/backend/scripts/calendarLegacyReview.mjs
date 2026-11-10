/**
 * Concilia e, SOMENTE sob dupla autorizacao, registra eventos GAS validados.
 * NUNCA cria, atualiza ou cancela eventos no Google Calendar.
 *
 * Preview: GOOGLE_CALENDAR_AUDIT_ENABLED=true node scripts/calendarLegacyReview.mjs 2026-11-01 2026-12-01
 * Import:  GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED=true ... --apply --expected-sha256=<hash-da-previa>
 *
 * O operador deve conferir as contagens, a legitimidade do calendario
 * e os casos excluidos. O resumo publico nao contem nomes ou IDs individuais.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { criarAdaptadorGoogleCalendarComOAuth } from "../src/googleCalendarTokenProvider.js";
import { prepararCandidatosLegados } from "../src/googleCalendarLegacyCandidates.js";
import { configuracaoCalendarOAuth } from "../src/googleCalendarOAuth.js";

function falhar(codigo){
  throw Object.assign(new Error("Revisao legado: "+codigo),{codigo});
}
function dia(v){
  if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v))falhar("DATA_INVALIDA");
  const d=new Date(v+"T12:00:00Z");
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v)falhar("DATA_INVALIDA");
  return v;
}
const params=process.argv.slice(2),de=dia(params[0]),ate=dia(params[1]);
const delta=Date.parse(ate)-Date.parse(de);
if(delta<=0||delta>30*86400000)falhar("PERIODO_INVALIDO");
const aplicar=params.includes("--apply");
if(params.length!==(aplicar?4:2))falhar("PARAMETROS_INVALIDOS");
const hashArg=params.find(x=>x.startsWith("--expected-sha256="));
if(aplicar && (!hashArg||!/^[a-f0-9]{64}$/.test(hashArg.slice(18)))) {
  falhar("DIGESTO_APROVACAO_AUSENTE");
}
if(process.env.GOOGLE_CALENDAR_AUDIT_ENABLED!=="true"||
   process.env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED==="true"||
   process.env.GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED==="true"||
   process.env.GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED==="true"){
  falhar("AUDITORIA_NAO_AUTORIZADA");
}
if(aplicar&&process.env.GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED!=="true"){
  falhar("GRAVACAO_NAO_AUTORIZADA");
}
const cfg=configuracaoCalendarOAuth();
let pool,conn;
try{
  pool=new pg.Pool({max:2,connectionTimeoutMillis:10000});
  if(!getApps().length){
    initializeApp({credential:applicationDefault(),projectId:"isabele-nails-app"});
  }
  const db=getFirestore();
  const google=criarAdaptadorGoogleCalendarComOAuth(pool);
  const [rows,snap,remote]=await Promise.all([
    pool.query(
      "SELECT agendamento_id,event_id,status,nome_cliente,servico,"+
      "TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso,"+
      "TO_CHAR(horario,'HH24:MI') AS hora_iso,duracao_minutos "+
      "FROM public.pix_calendar_outbox "+
      "WHERE data_servico >= $1::date AND data_servico < $2::date "+
      "ORDER BY data_servico,horario,agendamento_id LIMIT 4001",[de,ate],
    ),
    db.collection("agendamentos").where("data",">=",de).where("data","<",ate)
      .limit(4001).get(),
    google.listarEventos({inicio:de+"T00:00:00-03:00",
      fim:ate+"T00:00:00-03:00",incluirDescricao:true}),
  ]);
  if(rows.rows.length>4000||snap.docs.length>4000||
     remote.completo!==true||!Array.isArray(remote.eventos))falhar("INVENTARIO_INCOMPLETO");
  const ids=rows.rows.map(r=>r.agendamento_id);
  const [cancel,links]=await Promise.all([
    ids.length ? pool.query(
      "SELECT agendamento_id,estado FROM public.agendamento_cancelamentos "+
      "WHERE agendamento_id=ANY($1::text[])",[ids],
    ) : Promise.resolve({rows:[]}),
    pool.query(
      "SELECT agendamento_id,google_event_id,origem,metodo_verificacao,calendar_id "+
      "FROM public.google_calendar_event_links WHERE calendar_id=$1 LIMIT 4001",[cfg.calendarId],
    ),
  ]);
  if(cancel.rows.length>4000||links.rows.length>4000)falhar("INVENTARIO_INCOMPLETO");
  const data=prepararCandidatosLegados({
    outbox:rows.rows,firestore:snap.docs.map(d=>({...d.data(),id:d.id})),
    cancelamentos:cancel.rows,eventos:remote.eventos,vinculos:links.rows,
    calendarId:cfg.calendarId,
  });
  const evidencias=data.candidatos.map(x=>x.fingerprintEvidencia).sort();
  const sha=createHash("sha256").update(evidencias.join("\n")).digest("hex");
  console.log(JSON.stringify({
    estado:"REVISAO_DE_LEGADO",
    periodo:{inicio:de,fimExclusivo:ate},
    fontes:{outbox:rows.rows.length,firestore:snap.docs.length,
      google:remote.eventos.length,paginasGoogle:remote.paginas},
    resultado:data.resumo,hashDaPrevia:sha,
    modo:aplicar?"APLICACAO_CONTROLADA":"SOMENTE_PREVIA",
  },null,2));
  if(!aplicar){
    console.log("Nenhum vinculo escrito. Excecoes permanecem para revisao.");
  }else{
    if(sha!==hashArg.slice(18))falhar("DIGESTO_MUDOU_NAO_APLICAR");
    if(data.candidatos.length===0)falhar("SEM_CANDIDATOS");
    conn=await pool.connect();
    await conn.query("BEGIN");
    try{
      await conn.query("SET LOCAL lock_timeout='5s'");
      await conn.query("SET LOCAL statement_timeout='30s'");
      const list=data.candidatos;
      // Revalidar origem, sem cancelamentos, estado 'enviado', referencia
      // antiga igual. UNIQUE em links impede compartilhamento de events.id.
      const inserted=await conn.query(
        "INSERT INTO public.google_calendar_event_links "+
        "(agendamento_id,calendar_id,google_event_id,origem,metodo_verificacao, "+
        "verificado_em,verificado_por) "+
        "SELECT c.agendamento_id,$4,c.google_event_id,'legado_validado', "+
        "'revisao_manual_confirmada',NOW(),'revisao-lote-aprovada' "+
        "FROM UNNEST($1::text[],$2::text[],$3::text[]) "+
        "AS c(agendamento_id,google_event_id,legacy_event_id) "+
        "JOIN public.pix_calendar_outbox AS o "+
        "ON o.agendamento_id=c.agendamento_id AND o.event_id=c.legacy_event_id "+
        "AND o.status='enviado' "+
        "WHERE NOT EXISTS(SELECT 1 FROM public.agendamento_cancelamentos x "+
        "WHERE x.agendamento_id=c.agendamento_id) "+
        "AND NOT EXISTS(SELECT 1 FROM public.google_calendar_event_links x "+
        "WHERE x.agendamento_id=c.agendamento_id OR "+
        "(x.calendar_id=$4 AND x.google_event_id=c.google_event_id)) "+
        "ON CONFLICT DO NOTHING RETURNING agendamento_id",
        [list.map(x=>x.agendamentoId),list.map(x=>x.googleEventId),
          list.map(x=>x.legacyEventId),cfg.calendarId],
      );
      if(inserted.rows.length!==list.length)falhar("COLISAO_OU_FONTE_ALTERADA");
      await conn.query("COMMIT");
      console.log("VINCULOS_LEGADOS_INSERIDOS="+inserted.rows.length);
    }catch(e){
      await conn.query("ROLLBACK").catch(()=>{});
      throw e;
    }finally{conn.release();conn=null;}
  }
}catch(e){
  console.error("RECONCILIACAO_FALHOU: "+(e.codigo||"AMBIENTE_NAO_VERIFICADO"));
  process.exitCode=1;
}finally{
  if(conn)conn.release();
  if(pool)await pool.end().catch(()=>{});
}
