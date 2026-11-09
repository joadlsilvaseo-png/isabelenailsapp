/**
 * Roteador opt-in para substituicao progressiva do Apps Script.
 * Se um fluxo direto falha, NUNCA chama GAS como fallback.
 * As flags especificas sao independentes da conexao OAuth (somente leitura).
 */
import { criarAdaptadorGoogleCalendarComOAuth } from "./googleCalendarTokenProvider.js";
import { gerarIdEventoGoogle } from "./googleCalendarEvents.js";
import { registrarIntencaoCalendar, reivindicarIntencaoCalendar,
  confirmarIntencaoCalendar, suspenderIntencaoIncerta } from "./googleCalendarSafeStore.js";

const FLUXOS = {
  criar_pix: "GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED",
  cancelar: "GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED",
  reagendar_pago: "GOOGLE_CALENDAR_DIRECT_REAGENDAR_PAGO_ENABLED",
  reagendar_isento: "GOOGLE_CALENDAR_DIRECT_REAGENDAR_ISENTO_ENABLED",
  alterar_servico: "GOOGLE_CALENDAR_DIRECT_ALTERAR_SERVICO_ENABLED",
};
const GERAIS = ["GOOGLE_CALENDAR_OAUTH_ENABLED","GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED",
  "GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED","GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED"];
function falhar(codigo) {
  throw Object.assign(new Error("Calendar bloqueado: "+codigo),{codigo});
}
function validarAg(id) {
  if(typeof id!=="string"|| !/^[A-Za-z0-9_-]{1,128}$/.test(id))falhar("AGENDAMENTO_INVALIDO");
  return id;
}
function periodo(data,hora,duracao) {
  const inicio=String(data||"")+"T"+String(hora||"").slice(0,5)+":00-03:00";
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00-03:00$/.test(inicio) ||
     !Number.isFinite(Date.parse(inicio)))falhar("DATA_INVALIDA");
  const n=Number(duracao);
  if(!Number.isSafeInteger(n)||n<1||n>600)falhar("DURACAO_INVALIDA");
  return {inicio,fim:new Date(Date.parse(inicio)+n*60000).toISOString()};
}
function corresponde(evento,tipo,dados,origem) {
  if(tipo==="cancelar")return !evento||evento.status==="cancelled";
  if(!evento||evento.status==="cancelled"||
     Date.parse(evento.start?.dateTime)!==Date.parse(dados.inicio)||
     Date.parse(evento.end?.dateTime)!==Date.parse(dados.fim)||
     evento.summary!==dados.servico+" - "+dados.nomeCliente)return false;
  if(origem==="legado_validado"){
    const ref="evt_"+dados.agendamentoId;
    return typeof evento.description==="string" &&
      new RegExp("(^|[^A-Za-z0-9_-])"+ref+"(?=$|[^A-Za-z0-9_-])")
        .test(evento.description);
  }
  const p=evento.extendedProperties?.private;
  return p?.isabeleOrigem==="isabele-vps" &&
    p?.isabeleAgendamentoId===dados.agendamentoId;
}
export function criarPonteCalendarDireto(pool,{
  env=process.env,adapterFactory=()=>criarAdaptadorGoogleCalendarComOAuth(pool,{env}),
}={}) {
  if(typeof pool?.query!=="function")falhar("POSTGRES_INDISPONIVEL");
  const calendarId=String(env.GOOGLE_CALENDAR_ID||"");
  let client;
  function habilitado(fluxo) {
    const flag=FLUXOS[fluxo];
    if(!flag)falhar("FLUXO_DESCONHECIDO");
    if(env[flag]!=="true")return false;
    if(!GERAIS.every(k=>env[k]==="true")||!calendarId||
       calendarId.length>300||/\s/.test(calendarId)){
      falhar("CUTOVER_FLAGS_INCOMPLETAS");
    }
    if(fluxo==="criar_pix"){
      // Evento novo da API usa marcador privado, nao a descricao legada
      // usada pelo GAS. Todas as operacoes subsequentes tambem precisam
      // usar API direta, e o frontend deve suprimir o POST legado no-cors.
      const dependentes=["cancelar","reagendar_pago","reagendar_isento","alterar_servico"];
      if(dependentes.some(nome=>env[FLUXOS[nome]]!=="true") ||
         env.GOOGLE_CALENDAR_FRONTEND_PWA_READY!=="true"){
        falhar("CUTOVER_CRIACAO_EXIGE_FLUXOS_E_FRONTEND");
      }
      const cutoff=String(env.GOOGLE_CALENDAR_CUTOVER_STARTED_AT||"");
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(cutoff)||
         !Number.isFinite(Date.parse(cutoff))||
         Date.parse(cutoff)>Date.now()+60000)falhar("CUTOVER_START_INVALIDO");
    }
    return true;
  }
  const adaptador=()=>client ||= adapterFactory();
  async function buscarLink(id){
    const q=await pool.query(
      "SELECT agendamento_id,google_event_id,origem,metodo_verificacao,situacao,calendar_id "+
      "FROM public.google_calendar_event_links WHERE agendamento_id=$1",[id]);
    const l=q.rows?.[0];
    if(!l||l.calendar_id!==calendarId||l.situacao!=="ativo"||
       !(l.origem==="vps"||
         (l.origem==="legado_validado" &&
          l.metodo_verificacao==="revisao_manual_confirmada"))){
      falhar("VINCULO_NAO_VALIDADO");
    }
    return l;
  }
  async function getRemoto(link,id){
    return link?.origem==="legado_validado"
      ? adaptador().consultarEventoLegado({eventId:id})
      : adaptador().consultarEvento({eventId:id});
  }
  async function enviar({fluxo,tipo,agendamentoId,chave,nomeCliente,servico,inicio,fim,inicioAnterior=null}){
    if(!habilitado(fluxo))falhar("FLUXO_DESATIVADO");
    const id=validarAg(agendamentoId);
    if(typeof chave!=="string"||!/^[A-Za-z0-9_-]{16,160}$/.test(chave)){
      falhar("CHAVE_INVALIDA");
    }
    const link=tipo==="criar"?null:await buscarLink(id);
    const eventId=link?.google_event_id||gerarIdEventoGoogle(id);
    const dados={agendamentoId:id,nomeCliente,servico,inicio,fim};
    const intencao=await registrarIntencaoCalendar(pool,{
      chaveIdempotencia:chave,agendamentoId:id,calendarId,tipo,
      googleEventId:eventId,pedido:{nomeCliente,servico,inicio,fim,inicioAnterior},
    },{env});
    if(intencao.estado==="concluida"){
      return {eventId,operationId:intencao.operationId,jaConcluida:true};
    }
    if(!["pendente","aguardando_confirmacao"].includes(intencao.estado)){
      falhar("OPERACAO_EM_PROCESSAMENTO");
    }
    const operationId=intencao.operationId;
    let leaseToken;
    if(intencao.estado==="aguardando_confirmacao") {
      // Retentativa SOMENTE GET: se o estado nao bate, revisao humana.
      const evento=await getRemoto(link,eventId);
      if(!corresponde(evento,tipo,dados,link?.origem))falhar("OPERACAO_PENDENTE_REVISAO");
      const lease=await pool.query(
        "SELECT lease_token FROM public.google_calendar_sync_operations "+
        "WHERE operation_id=$1 AND estado='aguardando_confirmacao'",[operationId]);
      leaseToken=lease.rows?.[0]?.lease_token;
      if(!leaseToken)falhar("LEASE_INDISPONIVEL");
      await confirmarIntencaoCalendar(pool,{operationId,leaseToken,
        googleEvent:evento||{id:eventId,status:"cancelled",ausenteConfirmado:true}},{env});
      return {eventId,operationId,recuperado:true};
    }
    const claimed=await reivindicarIntencaoCalendar(pool,{calendarId,operationId},{env});
    if(claimed?.operation_id!==operationId)falhar("OPERACAO_EM_PROCESSAMENTO");
    leaseToken=claimed.lease_token;
    try {
      if(tipo==="criar") await adaptador().criarEvento(dados);
      else if(tipo==="cancelar") {
        if(link.origem==="legado_validado"){
          await adaptador().excluirEventoLegado({
            eventId,agendamentoId:id,legacyEventId:"evt_"+id,
          });
        } else await adaptador().excluirEvento({eventId,agendamentoId:id});
      } else if(link.origem==="legado_validado") {
        await adaptador().atualizarEventoLegado({
          ...dados,eventId,legacyEventId:"evt_"+id,inicioAnterior,
        });
      } else await adaptador().atualizarEvento({...dados,eventId});
      const evento=await getRemoto(link,eventId);
      if(!corresponde(evento,tipo,dados,link?.origem)){
        falhar("GOOGLE_RESPOSTA_DIVERGENTE");
      }
      await confirmarIntencaoCalendar(pool,{operationId,leaseToken,
        googleEvent:evento||{id:eventId,status:"cancelled",ausenteConfirmado:true}},{env});
      return {eventId,operationId,confirmado:true};
    }catch(e){
      await suspenderIntencaoIncerta(pool,{
        operationId,leaseToken,codigo:"GOOGLE_CALENDAR_SEM_CONFIRMACAO",
      },{env}).catch(()=>{});
      throw e;
    }
  }
  return {
    habilitado,
    criarPix(row) {
      const id=validarAg(row.agendamento_id);
      const p=periodo(row.data_servico_iso,row.horario,row.duracao_minutos);
      return enviar({fluxo:"criar_pix",tipo:"criar",agendamentoId:id,
        chave:"imn-criar-"+id,nomeCliente:row.nome_cliente,servico:row.servico,...p});
    },
    cancelar(row) {
      const id=validarAg(row.agendamento_id);
      return enviar({fluxo:"cancelar",tipo:"cancelar",agendamentoId:id,
        chave:"imn-cancelar-"+id,nomeCliente:null,servico:null,inicio:null,fim:null});
    },
    reagendarPago(payload) {
      const legacy=String(payload.eventId||"");
      if(!/^evt_[A-Za-z0-9_-]{1,128}$/.test(legacy))falhar("REFERENCIA_INVALIDA");
      const str=String(payload.dataInicio||"");
      if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(str))falhar("DATA_INVALIDA");
      const p=periodo(str.slice(0,10),str.slice(11,16),payload.duracaoMinutos);
      if(!payload.origemData || !payload.origemHorario)falhar("ORIGEM_AUSENTE");
      const inicioAnterior=periodo(payload.origemData,payload.origemHorario,1).inicio;
      return enviar({fluxo:"reagendar_pago",tipo:"reagendar",
        agendamentoId:legacy.slice(4),
        chave:"imn-reagendar-"+String(payload.operationId||""),
        nomeCliente:payload.nomeCliente,servico:payload.servico,...p,inicioAnterior});
    },
    reagendarIsento({agendamentoId,operationId,nomeCliente,servico,data,horario,duracao,origemData,origemHorario}) {
      const id=validarAg(agendamentoId);
      const p=periodo(data,horario,duracao);
      const inicioAnterior=periodo(origemData,origemHorario,1).inicio;
      return enviar({fluxo:"reagendar_isento",tipo:"reagendar",
        agendamentoId:id,chave:"imn-reagendar-isento-"+String(operationId||""),
        nomeCliente,servico,...p,inicioAnterior});
    },
    alterarServico(row) {
      const legacy=String(row.calendar_event_id||"");
      if(!/^evt_[A-Za-z0-9_-]{1,128}$/.test(legacy))falhar("REFERENCIA_INVALIDA");
      const hora=String(Math.floor(Number(row.inicio_minuto)/60)).padStart(2,"0")+":"+
        String(Number(row.inicio_minuto)%60).padStart(2,"0");
      const p=periodo(row.data_servico,hora,row.duracao_nova);
      return enviar({fluxo:"alterar_servico",tipo:"alterar_servico",
        agendamentoId:legacy.slice(4),
        chave:"imn-servico-"+String(row.operation_id||""),
        nomeCliente:row.nome_cliente,servico:row.novo_servico_nome,...p,inicioAnterior:p.inicio});
    },
  };
}
