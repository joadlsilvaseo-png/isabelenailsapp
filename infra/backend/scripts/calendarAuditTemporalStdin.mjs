/**
 * Auditoria de correspondencia temporal em modo READ-ONLY.
 *
 * Executa via stdin em isabele-infra-api-1 (imagem oauth-stage).
 * Compara apenas em memoria horarios/duracoes/nomes ja presentes no Google
 * e outbox. NUNCA imprime nome, identificador de reserva, titulo, credencial
 * ou token. Nao preenche tabelas ou sincroniza eventos.
 *
 * PROIBIDO usar resultado para vincular automaticamente eventos legados.
 */
import pg from "pg";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  configuracaoCalendarOAuth, descriptografarCalendarToken,
} from "/app/src/googleCalendarOAuth.js";

function falhar(codigo) {
  throw Object.assign(new Error(codigo), { codigo });
}
function validarDia(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) falhar("DATA_INVALIDA");
  const d = new Date(valor + "T12:00:00Z");
  if (!Number.isFinite(d.valueOf()) || d.toISOString().slice(0, 10) !== valor) {
    falhar("DATA_INVALIDA");
  }
  return valor;
}
async function google(url, options) {
  let resp;
  try {
    resp = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch {
    falhar("GOOGLE_INDISPONIVEL");
  }
  if (!resp.ok) falhar("GOOGLE_HTTP_" + resp.status);
  try { return await resp.json(); }
  catch { falhar("GOOGLE_JSON_INVALIDO"); }
}
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Sao_Paulo",
  hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
function chaveHorario(data) {
  if (typeof data !== "string") return null;
  const ms = Date.parse(data);
  if (!Number.isFinite(ms)) return null;
  const c = Object.fromEntries(fmt.formatToParts(new Date(ms))
    .filter(x => ["year", "month", "day", "hour", "minute"].includes(x.type))
    .map(x => [x.type, x.value]));
  return c.year + "-" + c.month + "-" + c.day + "T" + c.hour + ":" + c.minute;
}
function normalizar(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function ocorrencias(obj, campo) {
  const mapa = Object.create(null);
  for (const x of obj) {
    const key = String(x?.[campo] ?? "indefinido").replace(/[^a-z0-9_-]/gi, "_");
    mapa[key] = (mapa[key] || 0) + 1;
  }
  return mapa;
}
function contarComparacoes(registros, eventos) {
  const porHora = new Map();
  for (const e of eventos) {
    if (!e.horario) continue;
    if (!porHora.has(e.horario)) porHora.set(e.horario, []);
    porHora.get(e.horario).push(e);
  }
  const r = {
    reservasAnalisadas: registros.length,
    mesmoInicio: 0, inicioUnico: 0, inicioEDuracao: 0,
    inicioDuracaoUnicos: 0, inicioDuracaoENome: 0,
    inicioDuracaoNomeEServico: 0, horarioSemCorrespondencia: 0,
    variasCorrespondenciasHorario: 0,
  };
  for (const row of registros) {
    const cand = porHora.get(row.horario) || [];
    if (!cand.length) { r.horarioSemCorrespondencia++; continue; }
    r.mesmoInicio++;
    if (cand.length === 1) r.inicioUnico++;
    if (cand.length > 1) r.variasCorrespondenciasHorario++;
    const dur = cand.filter(e => e.duracao === row.duracao);
    if (!dur.length) continue;
    r.inicioEDuracao++;
    if (dur.length === 1) r.inicioDuracaoUnicos++;
    const nome = normalizar(row.nome);
    const servico = normalizar(row.servico);
    const nom = dur.filter(e => nome.length >= 5 &&
      (" " + e.summary + " ").includes(" " + nome + " "));
    if (nom.length) r.inicioDuracaoENome++;
    if (nom.some(e => servico.length >= 4 &&
      (" " + e.summary + " ").includes(" " + servico + " "))) {
      r.inicioDuracaoNomeEServico++;
    }
  }
  return r;
}

let pool;
try {
  const [de, ate] = process.argv.slice(2);
  const inicio = validarDia(de), fim = validarDia(ate);
  const delta = Date.parse(fim) - Date.parse(inicio);
  if (delta <= 0 || delta > 30 * 86400000) falhar("JANELA_INVALIDA");
  for (const flag of [
    "GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED", "GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED",
  ]) if (process.env[flag] === "true") falhar("ESCRITA_NAO_DESATIVADA");

  const cfg = configuracaoCalendarOAuth();
  pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 10000 });
  const con = await pool.connect();
  let outbox, cancelamentos, credencial;
  try {
    await con.query("BEGIN TRANSACTION READ ONLY");
    outbox = (await con.query(
      "SELECT agendamento_id, event_id, status, " +
      "TO_CHAR(data_servico,'YYYY-MM-DD') AS data_iso, " +
      "TO_CHAR(horario,'HH24:MI') AS hora_iso, " +
      "duracao_minutos, nome_cliente, servico " +
      "FROM public.pix_calendar_outbox " +
      "WHERE data_servico >= $1::date AND data_servico < $2::date " +
      "ORDER BY data_servico,horario,agendamento_id LIMIT 4001",
      [inicio, fim],
    )).rows;
    if (outbox.length > 4000) falhar("LIMITE_POSTGRESQL");
    cancelamentos = outbox.length ? (await con.query(
      "SELECT agendamento_id,estado,calendar_estado " +
      "FROM public.agendamento_cancelamentos " +
      "WHERE agendamento_id = ANY($1::text[])",
      [outbox.map(x => x.agendamento_id)],
    )).rows : [];
    credencial = (await con.query(
      "SELECT google_email,refresh_token_encrypted " +
      "FROM public.google_calendar_oauth_credentials " +
      "WHERE connection_name = 'isabele'",
    )).rows[0];
    await con.query("COMMIT");
  } catch (e) {
    await con.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { con.release(); }
  if (credencial?.google_email?.trim().toLowerCase() !== cfg.expectedEmail) {
    falhar("CONTA_DIVERGENTE");
  }
  const refresh = descriptografarCalendarToken(credencial.refresh_token_encrypted, cfg.key);
  const t = await google("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      refresh_token: refresh, grant_type: "refresh_token",
    }),
  });
  if (!t.access_token || (t.refresh_token && t.refresh_token !== refresh)) {
    falhar("TOKEN_INDISPONIVEL_OU_ROTACIONADO");
  }
  const headers = { Authorization: "Bearer " + t.access_token };
  const me = await google("https://openidconnect.googleapis.com/v1/userinfo", { headers });
  if (!me.email_verified || me.email?.trim().toLowerCase() !== cfg.expectedEmail) {
    falhar("IDENTIDADE_DIVERGENTE");
  }

  const eventos = [];
  const tokensVistos = new Set();
  let proxima = "", paginas = 0;
  for (let p = 0; p < 10; p++) {
    const u = new URL("https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(cfg.calendarId) + "/events");
    u.searchParams.set("timeMin", inicio + "T00:00:00-03:00");
    u.searchParams.set("timeMax", fim + "T00:00:00-03:00");
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("showDeleted", "false");
    u.searchParams.set("orderBy", "startTime");
    u.searchParams.set("maxResults", "250");
    // Titulo fica APENAS na memoria para comparacao; nunca aparece na saida.
    u.searchParams.set("fields",
      "kind,nextPageToken,items(id,iCalUID,status,summary,start(date,dateTime),end(date,dateTime),recurringEventId)");
    if (proxima) u.searchParams.set("pageToken", proxima);
    const page = await google(u, { headers });
    if (page.kind !== "calendar#events" || !Array.isArray(page.items || [])) {
      falhar("GOOGLE_PAGINA_INVALIDA");
    }
    eventos.push(...(page.items || []));
    paginas++;
    if (eventos.length > 1500) falhar("GOOGLE_LIMITE");
    proxima = page.nextPageToken || "";
    if (!proxima) break;
    if (tokensVistos.has(proxima)) falhar("GOOGLE_PAGINA_REPETIDA");
    tokensVistos.add(proxima);
  }
  if (proxima) falhar("GOOGLE_PAGINACAO_INCOMPLETA");

  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  }
  const docs = (await getFirestore().collection("agendamentos")
    .where("data", ">=", inicio).where("data", "<", fim).limit(4001).get()).docs;
  if (docs.length > 4000) falhar("FIRESTORE_LIMITE");

  const cancelado = new Set(cancelamentos
    .filter(x => x.estado === "concluida").map(x => x.agendamento_id));
  const fsIDs = new Set(docs.map(x => x.id));
  const pgComData = outbox.map(x => ({
    agendamentoId: x.agendamento_id,
    nome: x.nome_cliente, servico: x.servico,
    horario: x.data_iso + "T" + x.hora_iso, duracao: Number(x.duracao_minutos),
    status: x.status, cancelado: cancelado.has(x.agendamento_id),
  }));
  const calendarComData = eventos.map(x => {
    const ini = x.start?.dateTime, final = x.end?.dateTime;
    const duracao = Number.isFinite(Date.parse(ini)) && Number.isFinite(Date.parse(final))
      ? (Date.parse(final) - Date.parse(ini)) / 60000 : null;
    return {
      horario: chaveHorario(ini),
      duracao, summary: normalizar(x.summary),
      diaInteiro: Boolean(x.start?.date),
      comTitulo: Boolean(x.summary),
      recorrencia: Boolean(x.recurringEventId),
    };
  });
  const ativos = pgComData.filter(x => x.status === "enviado" && !x.cancelado);
  const fsAgendamentos = docs.map(d => {
    const x = d.data();
    return { horario: String(x?.data || "") + "T" + String(x?.horario || "").slice(0, 5),
      nome: x?.nomeCliente, servico: x?.servico, duracao: Number(x?.duracaoMinutos || 0) };
  });
  const validosFS = fsAgendamentos.filter(x => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x.horario));
  console.log(JSON.stringify({
    resultado: "DIAGNOSTICO_TEMPORAL_SOMENTE_LEITURA",
    periodo: { inicio, fimExclusivo: fim },
    fontes: { postgresOutbox: outbox.length, firestore: docs.length,
      eventosGoogle: eventos.length, paginasGoogle: paginas },
    referencias: {
      postgresEventIdsPrefixoEvt: outbox.filter(x => /^evt_[A-Za-z0-9_-]+$/.test(x.event_id)).length,
      firestoreComIdNaOutbox: docs.filter(d => outbox.some(o=>o.agendamento_id===d.id)).length,
      registrosOutboxSemDocNoPeriodo: outbox.filter(o=>!fsIDs.has(o.agendamento_id)).length,
      firestoreComCalendarEventId: docs.filter(d=>Boolean(d.data()?.calendarEventId)).length,
    },
    postgres: { status: ocorrencias(outbox, "status"), cancelamentos: cancelado.size,
      enviadosNaoCancelados: ativos.length },
    google: { eventosDiaInteiro: calendarComData.filter(x=>x.diaInteiro).length,
      eventosComInicio: calendarComData.filter(x=>x.horario).length,
      eventosComTitulo: calendarComData.filter(x=>x.comTitulo).length,
      recorrencias: calendarComData.filter(x=>x.recorrencia).length },
    comparacaoOutboxEnviadaNaoCancelada: contarComparacoes(ativos, calendarComData),
    comparacaoFirestoreDataAtual: contarComparacoes(validosFS, calendarComData),
    aviso: "Correspondencia temporal e nome sao apenas indicios, nunca aprovacao automatica.",
  }, null, 2));
} catch (e) {
  console.error("DIAGNOSTICO_FALHOU: " + (e.codigo || "ERRO_AMBIENTE"));
  process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => {});
}
