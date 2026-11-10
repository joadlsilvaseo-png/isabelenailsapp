/**
 * Auditoria operacional isolada — EXECUTAR APENAS via stdin dentro do container
 * isabele-infra-api-1 (WORKDIR /app, imagem OAuth-stage).
 *
 * Nenhum INSERT/UPDATE/DELETE, nenhum evento mutado, nenhum token ou dado pessoal
 * impresso. POST exclusivamente para o endpoint de renovacao OAuth Google.
 * Nao importa modulos novos das PRs (imagem OAuth-staging ainda nao os possui).
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
function validarDia(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      new Date(v + "T12:00:00Z").toISOString().slice(0, 10) !== v) {
    falhar("DATA_INVALIDA");
  }
  return v;
}
async function pedirGoogle(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch {
    falhar("GOOGLE_INDISPONIVEL");
  }
  if (!response.ok) falhar("GOOGLE_HTTP_" + response.status);
  try { return await response.json(); }
  catch { falhar("GOOGLE_RESPOSTA_INVALIDA"); }
}

let pool;
try {
  const [primeiro, ultimo] = process.argv.slice(2);
  const inicio = validarDia(primeiro);
  const fim = validarDia(ultimo);
  const intervalo = Date.parse(fim) - Date.parse(inicio);
  if (intervalo <= 0 || intervalo > 30 * 86400000) falhar("JANELA_MAIOR_QUE_30_DIAS");
  for (const flag of [
    "GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED",
    "GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED",
  ]) if (process.env[flag] === "true") falhar("FLAG_DE_ESCRITA_ATIVA");

  const cfg = configuracaoCalendarOAuth(process.env);
  pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 10000 });
  const conn = await pool.connect();
  let outbox, credencial, links;
  try {
    await conn.query("BEGIN TRANSACTION READ ONLY");
    outbox = (await conn.query(
      "SELECT agendamento_id,event_id FROM public.pix_calendar_outbox " +
      "WHERE data_servico >= $1::date AND data_servico < $2::date " +
      "ORDER BY data_servico,agendamento_id LIMIT 4001", [inicio, fim],
    )).rows;
    links = (await conn.query(
      "SELECT agendamento_id,google_event_id FROM public.google_calendar_event_links LIMIT 4001",
    )).rows;
    credencial = (await conn.query(
      "SELECT google_email,refresh_token_encrypted " +
      "FROM public.google_calendar_oauth_credentials WHERE connection_name='isabele'",
    )).rows[0];
    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { conn.release(); }
  if (outbox.length > 4000 || links.length > 4000) falhar("LIMITE_POSTGRESQL");
  if (credencial?.google_email?.trim().toLowerCase() !== cfg.expectedEmail) {
    falhar("CONTA_GOOGLE_DIVERGENTE");
  }
  const refresh = descriptografarCalendarToken(credencial.refresh_token_encrypted, cfg.key);
  const tokens = await pedirGoogle("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refresh, client_id: cfg.clientId,
      client_secret: cfg.clientSecret, grant_type: "refresh_token",
    }),
  });
  if (!tokens?.access_token) falhar("TOKEN_DE_ACESSO_AUSENTE");
  if (tokens.refresh_token && tokens.refresh_token !== refresh) {
    falhar("REFRESH_TOKEN_ROTACIONADO_REVISAR");
  }
  const headers = { Authorization: "Bearer " + tokens.access_token };
  const usuario = await pedirGoogle("https://openidconnect.googleapis.com/v1/userinfo", { headers });
  if (usuario.email_verified !== true ||
      usuario.email?.trim().toLowerCase() !== cfg.expectedEmail) {
    falhar("IDENTIDADE_GOOGLE_DIVERGENTE");
  }

  const eventos = [];
  const paginasVistas = new Set();
  let pageToken = "", paginas = 0;
  for (let pagina = 0; pagina < 10; pagina++) {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(cfg.calendarId) + "/events");
    url.searchParams.set("timeMin", inicio + "T00:00:00-03:00");
    url.searchParams.set("timeMax", fim + "T00:00:00-03:00");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("fields",
      "kind,nextPageToken,items(id,iCalUID,status,recurringEventId,extendedProperties(private))");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await pedirGoogle(url, { headers });
    if (r.kind !== "calendar#events" || !Array.isArray(r.items || [])) {
      falhar("PAGINA_CALENDAR_INVALIDA");
    }
    eventos.push(...(r.items || []));
    paginas++;
    if (eventos.length > 1500) falhar("GOOGLE_LIMITE_EVENTOS");
    pageToken = r.nextPageToken || "";
    if (!pageToken) break;
    if (paginasVistas.has(pageToken)) falhar("PAGINACAO_GOOGLE_REPETIDA");
    paginasVistas.add(pageToken);
  }
  if (pageToken) falhar("PAGINACAO_GOOGLE_INCOMPLETA");

  if (!getApps().length) initializeApp({
    credential: applicationDefault(), projectId: "isabele-nails-app",
  });
  const docs = (await getFirestore().collection("agendamentos")
    .where("data", ">=", inicio).where("data", "<", fim).limit(4001).get()).docs;
  if (docs.length > 4000) falhar("LIMITE_FIRESTORE");

  const refs = new Map();
  function adicionar(agendamento, ref) {
    if (typeof agendamento !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(agendamento)) return;
    if (!refs.has(agendamento)) refs.set(agendamento, new Set());
    if (typeof ref === "string" && ref.length <= 1024 && ref) refs.get(agendamento).add(ref);
  }
  for (const d of docs) adicionar(d.id, d.data()?.calendarEventId);
  for (const r of outbox) adicionar(r.agendamento_id, r.event_id);
  const byId = new Map(), byIcal = new Map();
  for (const e of eventos) {
    if (typeof e.id !== "string" || byId.has(e.id)) falhar("EVENTO_DUPLICADO_OU_INVALIDO");
    byId.set(e.id, e);
    if (typeof e.iCalUID === "string") {
      if (!byIcal.has(e.iCalUID)) byIcal.set(e.iCalUID, new Set());
      byIcal.get(e.iCalUID).add(e.id);
    }
    const p = e.extendedProperties?.private;
    if (p?.isabeleOrigem === "isabele-vps") adicionar(p.isabeleAgendamentoId, e.id);
  }

  const resumo = { correspondenciasUnicas: 0, ambiguidades: 0,
    semCorrespondencia: 0, recorrencias: 0, marcadoresVps: 0, colisoes: 0 };
  const reclamacoes = new Map();
  const porAgendamento = [];
  for (const [id, referencia] of refs) {
    const ids = new Set();
    for (const ref of referencia) {
      if (byId.has(ref)) ids.add(ref);
      for (const eventoId of byIcal.get(ref) || []) ids.add(eventoId);
    }
    if (ids.size === 0) resumo.semCorrespondencia++;
    else if (ids.size === 1) resumo.correspondenciasUnicas++;
    else resumo.ambiguidades++;
    if ([...ids].some(x => byId.get(x)?.recurringEventId)) resumo.recorrencias++;
    if ([...ids].some(x => byId.get(x)?.extendedProperties?.private?.isabeleOrigem === "isabele-vps")) {
      resumo.marcadoresVps++;
    }
    for (const eventoId of ids) {
      if (!reclamacoes.has(eventoId)) reclamacoes.set(eventoId, new Set());
      reclamacoes.get(eventoId).add(id);
    }
    porAgendamento.push([...ids]);
  }
  for (const ids of porAgendamento) {
    if (ids.some(x => reclamacoes.get(x).size > 1)) resumo.colisoes++;
  }
  console.log(JSON.stringify({
    resultado: "AUDITORIA_SOMENTE_LEITURA_CONCLUIDA",
    janela: { inicio, fimExclusivo: fim },
    fontes: { firestore: docs.length, postgresOutbox: outbox.length,
      vinculosConfirmados: links.length, eventosGoogle: eventos.length, paginasGoogle: paginas },
    agendamentosAnalisados: refs.size,
    candidatos: { ...resumo, eventosGoogleSemReferencia: eventos.length - reclamacoes.size },
    aviso: "Candidatos nao sao vinculos confirmados. Inclui cancelados e eventos particulares; nao fazer backfill.",
  }, null, 2));
} catch (e) {
  console.error("AUDITORIA_FALHOU: " + (e.codigo || "ERRO_AMBIENTE_SEM_EXPOR_SEGREDOS"));
  process.exitCode = 1;
} finally {
  if (pool) await pool.end().catch(() => {});
}
