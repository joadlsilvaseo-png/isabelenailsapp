/**
 * Permite que SOMENTE uma outbox pix_calendar_outbox criada no fluxo de
 * confirmacao do booking atual ganhe a autorizacao de criacao direta.
 * Nao reprocessa historico, nao modifica Firestore e nao chama Google.
 *
 * Deve ser invocado dentro da mesma transacao que insere a linha na outbox;
 * nunca por job agendado nem por comando de backfill.
 */
import { createHash } from "node:crypto";

function falhar(codigo){
  throw Object.assign(new Error("Autorizacao nova reserva: "+codigo),{codigo});
}
export async function autorizarCriacaoNovoCalendar(conexao,{
  outboxId,agendamentoId,env=process.env,
}={}) {
  if(env.GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED!=="true"){
    return {autorizada:false,desativada:true};
  }
  const at=String(env.GOOGLE_CALENDAR_CUTOVER_STARTED_AT||"");
  const inicio=Date.parse(at);
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(at)||
     !Number.isFinite(inicio) || inicio<Date.parse("2026-01-01T00:00:00Z") ||
     inicio>Date.now()+60000){
    falhar("INICIO_CUTOVER_INVALIDO");
  }
  if(typeof agendamentoId!=="string"||
     !/^[A-Za-z0-9_-]{1,128}$/.test(agendamentoId)||
     !Number.isSafeInteger(Number(outboxId))||Number(outboxId)<1){
    falhar("REGISTRO_INVALIDO");
  }
  if(typeof conexao?.query!=="function")falhar("CONEXAO_INDISPONIVEL");
  const calendarId=String(env.GOOGLE_CALENDAR_ID||"");
  if(!calendarId||calendarId.length>300||/\s/.test(calendarId))falhar("CALENDARIO_INVALIDO");
  const hash=createHash("sha256")
    .update("isabele-cutover-autorizacao-v1:"+outboxId+":"+agendamentoId+":"+at)
    .digest("hex");
  // Esta consulta so vale para a linha recem inserida e nunca pode autorizar
  // um registro GAS antigo ou ja enviado. A FK entre links e outbox nao existe.
  const r=await conexao.query(
    "INSERT INTO public.google_calendar_creation_authorizations "+
    "(agendamento_id,calendar_id,autorizacao,evidencia_sha256,autorizado_por) "+
    "SELECT fila.agendamento_id,$3,'nova_reserva_verificada',$4,'api-pos-corte' "+
    "FROM public.pix_calendar_outbox fila "+
    "WHERE fila.id=$1 AND fila.agendamento_id=$2 "+
    "AND fila.criado_em >= $5::timestamptz "+
    "AND fila.status='pendente' AND fila.tentativas=0 "+
    "AND NOT EXISTS (SELECT 1 FROM public.google_calendar_event_links l "+
    "WHERE l.agendamento_id=fila.agendamento_id) "+
    "AND NOT EXISTS (SELECT 1 FROM public.google_calendar_reconciliation_candidates c "+
    "WHERE c.agendamento_id=fila.agendamento_id AND c.situacao <> 'rejeitado') "+
    "ON CONFLICT (agendamento_id) DO NOTHING RETURNING agendamento_id",
    [outboxId,agendamentoId,calendarId,hash,at],
  );
  return {autorizada:r.rows?.length===1};
}
