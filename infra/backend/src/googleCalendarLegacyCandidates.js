/**
 * Reconciliacao de eventos legados por referencia exata na descricao.
 *
 * Preparacao local sem I/O, escrita ou chamada remota.
 * NUNCA chama este modulo para editar eventos, gravar vinculos automaticamente
 * ou para assumir que coincidencia de titulo/horario e identificador de evento.
 *
 * Cada candidato exige verificacao da fonte remota atualizada e aprovacao
 * operacional antes de qualquer persistencia.
 */
import { createHash } from "node:crypto";

const ID_RESERVA = /^[A-Za-z0-9_-]{1,128}$/;
const ID_EVENTO = /^[A-Za-z0-9_-]{5,1024}$/;
const FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
const ESTADOS_PERMITIDOS = new Set([
  "confirmado", "reagendado", "agendado",
  "concluido", "concluida", "finalizado", "finalizada",
  "realizado", "realizada",
]);

function falhar(codigo) {
  throw Object.assign(new Error("Conciliacao de legado: " + codigo), { codigo });
}
function normalizar(value) {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")
    : "";
}
function marcado(descricao, referencia) {
  if (typeof descricao !== "string" || !/^evt_[A-Za-z0-9_-]{1,128}$/.test(referencia)) {
    return false;
  }
  const expression = new RegExp("(^|[^A-Za-z0-9_-])" + referencia + "(?=$|[^A-Za-z0-9_-])");
  return expression.test(descricao);
}
function horarioSaoPaulo(iso) {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return null;
  const values = Object.fromEntries(FMT.formatToParts(new Date(iso))
    .filter(x => ["year", "month", "day", "hour", "minute"].includes(x.type))
    .map(x => [x.type, x.value]));
  return values.year+"-"+values.month+"-"+values.day+"T"+values.hour+":"+values.minute;
}
function textoContem(titulo, valor, minimo) {
  const normalized = normalizar(valor);
  return normalized.length >= minimo &&
    (" "+normalizar(titulo)+" ").includes(" "+normalized+" ");
}
function validarArray(array, label, max) {
  if (!Array.isArray(array) || array.length > max) falhar("LISTA_"+label+"_INVALIDA");
}
function perfilOperacao(row, doc, event) {
  const horarioOriginal = row.data_iso+"T"+row.hora_iso;
  const eventoInicio = horarioSaoPaulo(event.start?.dateTime);
  const eventoDuracao = typeof event.start?.dateTime === "string" &&
    typeof event.end?.dateTime === "string"
      ? (Date.parse(event.end.dateTime)-Date.parse(event.start.dateTime))/60000
      : null;
  const duracaoFirestore = Number(doc?.duracaoSnapshot ?? doc?.duracao ?? doc?.duracaoMinutos);
  const horarioFirestore = doc ? String(doc.data||"")+"T"+String(doc.horario||"").slice(0,5) : null;
  return {
    horarioOriginal, eventoInicio, eventoDuracao, duracaoFirestore, horarioFirestore,
    horarioOriginalIgual: horarioOriginal === eventoInicio,
    duracaoOriginalIgual: Number(row.duracao_minutos) === eventoDuracao,
    horarioFirestoreIgual: horarioFirestore === eventoInicio,
    duracaoFirestoreIgual: duracaoFirestore === eventoDuracao && duracaoFirestore > 0,
    tituloCorresponde: textoContem(event.summary,row.nome_cliente,5) &&
      textoContem(event.summary,row.servico,4),
  };
}

/**
 * O resultado e confidencial pois os detalhes possuem IDs de reservas e
 * eventos. Imprimir somente .resumo em logs; nao postar .candidatos em chat.
 * @returns {{somenteLeitura: true, resumo: object, candidatos: object[], revisoes: object[]}}
 */
export function prepararCandidatosLegados({
  outbox=[], firestore=[], eventos=[], cancelamentos=[], vinculos=[], calendarId,
} = {}) {
  if (typeof calendarId !== "string" || calendarId.length < 1 || calendarId.length > 300 ||
      /\s/.test(calendarId)) falhar("CALENDARIO_INVALIDO");
  validarArray(outbox,"OUTBOX",4000);
  validarArray(firestore,"FIRESTORE",4000);
  validarArray(eventos,"EVENTOS",1500);
  validarArray(cancelamentos,"CANCELAMENTOS",4000);
  validarArray(vinculos,"VINCULOS",4000);

  const fs = new Map();
  for (const row of firestore) {
    if (!ID_RESERVA.test(row?.id)) falhar("FIRESTORE_ID_INVALIDO");
    if (fs.has(row.id)) falhar("FIRESTORE_REPETIDO");
    fs.set(row.id,row);
  }
  const porAgendamento = new Map();
  const porEvento = new Map();
  for (const l of vinculos) {
    if (!ID_RESERVA.test(l?.agendamento_id) || !ID_EVENTO.test(l?.google_event_id)) {
      falhar("VINCULO_INVALIDO");
    }
    if (porAgendamento.has(l.agendamento_id)) falhar("VINCULO_DUPLICADO");
    if (porEvento.has(l.google_event_id)) falhar("VINCULO_DUPLICADO");
    porAgendamento.set(l.agendamento_id,l);
    porEvento.set(l.google_event_id,l);
  }

  const cancelamento = new Map();
  for (const row of cancelamentos) {
    if (!ID_RESERVA.test(row?.agendamento_id)) falhar("CANCELAMENTO_ID_INVALIDO");
    if (cancelamento.has(row.agendamento_id)) falhar("CANCELAMENTO_REPETIDO");
    cancelamento.set(row.agendamento_id,row);
  }
  const eventosPorId = new Map();
  for (const ev of eventos) {
    if (!ID_EVENTO.test(ev?.id)) falhar("EVENTO_ID_INVALIDO");
    if (eventosPorId.has(ev.id)) falhar("EVENTO_REPETIDO");
    eventosPorId.set(ev.id,ev);
  }

  const reivindicacoes = new Map();
  const refs = new Map();
  const registros = [];
  for (const row of outbox) {
    if (!ID_RESERVA.test(row?.agendamento_id) ||
        !/^evt_[A-Za-z0-9_-]{1,128}$/.test(row?.event_id)) {
      falhar("OUTBOX_ID_INVALIDO");
    }
    if (refs.has(row.agendamento_id)) falhar("OUTBOX_DUPLICADA");
    refs.set(row.agendamento_id,row);
    const matches = eventos.filter(ev=>marcado(ev.description,row.event_id));
    for (const ev of matches) {
      if (!reivindicacoes.has(ev.id)) reivindicacoes.set(ev.id,new Set());
      reivindicacoes.get(ev.id).add(row.agendamento_id);
    }
    registros.push({ row, matches });
  }

  const resumo = {
    registrosOutbox: outbox.length, matchesUnicos: 0,
    candidatosARevisao: 0, vinculacoesCriadas: 0,
    cancelamentosSemEvento: 0,
    excecoes: {},
  };
  const candidatos = [], revisoes = [];
  function revisar(row, motivo, evento) {
    resumo.excecoes[motivo] = (resumo.excecoes[motivo] || 0)+1;
    revisoes.push({ agendamentoId: row.agendamento_id,
      googleEventId: evento?.id ?? null, motivo });
  }
  for (const {row,matches} of registros) {
    const cancell = cancelamento.get(row.agendamento_id);
    if (matches.length===0) {
      if (cancell?.estado==="concluida") { resumo.cancelamentosSemEvento++; continue; }
      revisar(row,"SEM_EVENTO"); continue;
    }
    if (matches.length !== 1) { revisar(row,"MULTIPLOS_EVENTOS"); continue; }
    resumo.matchesUnicos++;
    const event = matches[0];
    if (reivindicacoes.get(event.id).size !== 1) {
      revisar(row,"EVENTO_COMPARTILHADO",event); continue;
    }
    const link = porAgendamento.get(row.agendamento_id);
    if (link && (link.google_event_id !== event.id || link.calendar_id !== calendarId)) {
      revisar(row,"VINCULO_EXISTENTE_DIVERGENTE",event); continue;
    }
    if (porEvento.has(event.id) && porEvento.get(event.id).agendamento_id !== row.agendamento_id) {
      revisar(row,"EVENTO_JA_VINCULADO",event); continue;
    }
    if (link) { revisar(row,"VINCULO_JA_EXISTENTE",event); continue; }
    if (cancell) { revisar(row,"CANCELAMENTO_EXISTENTE",event); continue; }
    if (row.status !== "enviado") { revisar(row,"OUTBOX_NAO_ENVIADA",event); continue; }
    if (event.status !== "confirmed") { revisar(row,"EVENTO_STATUS_NAO_CONFIRMADO",event); continue; }
    if (event.recurringEventId) { revisar(row,"RECORRENCIA",event); continue; }
    const doc=fs.get(row.agendamento_id);
    if (!doc) { revisar(row,"FIRESTORE_AUSENTE",event); continue; }
    if (doc.calendarEventId !== row.event_id) {
      revisar(row,"REFERENCIA_FIRESTORE_DIVERGENTE",event); continue;
    }
    if (!ESTADOS_PERMITIDOS.has(String(doc.status||"").trim().toLowerCase())) {
      revisar(row,"FIRESTORE_STATUS_REVISAR",event); continue;
    }
    const p=perfilOperacao(row,doc,event);
    if (!p.horarioOriginalIgual) { revisar(row,"HORARIO_OUTBOX_DIVERGENTE",event); continue; }
    if (!p.duracaoOriginalIgual) { revisar(row,"DURACAO_OUTBOX_DIVERGENTE",event); continue; }
    if (!p.horarioFirestoreIgual) { revisar(row,"HORARIO_FIRESTORE_DIVERGENTE",event); continue; }
    if (!p.duracaoFirestoreIgual) { revisar(row,"DURACAO_FIRESTORE_DIVERGENTE",event); continue; }
    if (!p.tituloCorresponde) { revisar(row,"TITULO_DIVERGENTE",event); continue; }
    const fingerprintEvidencia=createHash("sha256").update(JSON.stringify({
      agendamentoId:row.agendamento_id, calendarId, legacyEventId:row.event_id,
      googleEventId:event.id,horario:p.eventoInicio,duracao:p.eventoDuracao,
      status:String(doc.status).toLowerCase(),
    })).digest("hex");
    candidatos.push({
      agendamentoId:row.agendamento_id, calendarId,
      googleEventId:event.id, legacyEventId:row.event_id,
      metodoVerificacao:"revisao_manual_confirmada",
      origem:"legado_validado",fingerprintEvidencia,
    });
    resumo.candidatosARevisao++;
  }
  return { somenteLeitura:true, resumo, candidatos, revisoes };
}
