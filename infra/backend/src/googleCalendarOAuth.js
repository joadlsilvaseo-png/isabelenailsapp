/**
 * OAuth Google Calendar: autorizacao e verificacao SOMENTE LEITURA.
 * Nao substitui o Apps Script ou os motores de reserva nesta fase.
 * Bloqueado ate GOOGLE_CALENDAR_OAUTH_ENABLED=true.
 */
import { randomBytes, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { verificarUsuario } from "./pushSubscriptions.js";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/";
const CALLBACK_PATH = "/oauth/google/callback";
const CONNECTION = "isabele";

function erro(codigo, mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { codigo, status });
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

function responderPagina(res, status, titulo, descricao) {
  // Os textos sao sempre literais ou codigos internos, jamais dados do OAuth.
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  res.end('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Google Calendar - Isabele</title><main style="font:16px system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:20px">' +
    '<h1>' + titulo + '</h1><p>' + descricao + '</p><p>Esta janela pode ser fechada.</p></main></html>');
}

export function criptografarCalendarToken(valor, chave) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chave, iv);
  const cifrado = Buffer.concat([cipher.update(String(valor), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cifrado.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function descriptografarCalendarToken(valor, chave) {
  const partes = String(valor || "").split(".");
  if (partes.length !== 4 || partes[0] !== "v1") {
    throw erro("TOKEN_INVALIDO", "Credencial armazenada invalida.", 503);
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", chave, Buffer.from(partes[1], "base64url"));
    decipher.setAuthTag(Buffer.from(partes[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(partes[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw erro("TOKEN_INVALIDO", "Credencial armazenada nao pode ser lida.", 503);
  }
}

export function configuracaoCalendarOAuth(env = process.env) {
  if (env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true") {
    throw erro("INTEGRACAO_DESABILITADA", "Integracao Google Calendar ainda nao ativada.", 503);
  }
  const clientId = String(env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET || "").trim();
  const redirectUri = String(env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI || "").trim();
  const calendarId = String(env.GOOGLE_CALENDAR_ID || "").trim();
  const expectedEmail = String(env.GOOGLE_CALENDAR_EXPECTED_EMAIL || "").trim().toLowerCase();
  const key = Buffer.from(String(env.GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY || ""), "base64url");
  let callback;
  try { callback = new URL(redirectUri); } catch { /* tratado abaixo */ }
  if (!clientId || !clientSecret || !callback || callback.protocol !== "https:" ||
      callback.pathname !== CALLBACK_PATH || callback.search || callback.hash ||
      callback.username || callback.password || !calendarId ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expectedEmail) || key.length !== 32) {
    throw erro("CONFIGURACAO_INCOMPLETA", "Integracao Google Calendar nao configurada.", 503);
  }
  return { clientId, clientSecret, redirectUri, calendarId, expectedEmail, key };
}

function sha256(valor, formato = "hex") {
  return createHash("sha256").update(valor).digest(formato);
}

async function solicitarGoogle(url, options, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(url, { ...options, signal: AbortSignal.timeout(12000) });
  } catch {
    throw erro("GOOGLE_INDISPONIVEL", "Falha na comunicacao com o Google.", 502);
  }
  if (!response.ok) throw erro("GOOGLE_REJEITOU", "Google recusou a requisicao.", 502);
  try {
    const obj = await response.json();
    if (!obj || typeof obj !== "object") throw new Error("JSON");
    return obj;
  } catch {
    throw erro("GOOGLE_RESPOSTA_INVALIDA", "Resposta inesperada do Google.", 502);
  }
}

async function validarEmailGoogle(accessToken, cfg, fetcher) {
  const profile = await solicitarGoogle(USERINFO_URL, {
    method: "GET", headers: { Authorization: "Bearer " + accessToken },
  }, fetcher);
  if (profile.email_verified !== true ||
      String(profile.email || "").trim().toLowerCase() !== cfg.expectedEmail) {
    throw erro("CONTA_GOOGLE_INCORRETA", "A conta autorizada nao corresponde a Isabele.", 403);
  }
}

async function leituraGoogle(accessToken, cfg, fetcher) {
  const url = new URL(CALENDAR_URL + encodeURIComponent(cfg.calendarId) + "/events");
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("fields", "kind,items(id)");
  const resposta = await solicitarGoogle(url.toString(), {
    method: "GET", headers: { Authorization: "Bearer " + accessToken },
  }, fetcher);
  if (resposta.kind !== "calendar#events") {
    throw erro("CALENDARIO_INCORRETO", "Calendario retornou resposta inesperada.", 502);
  }
}

async function criarAutorizacao(pool, uid, cfg) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  await pool.query("DELETE FROM public.google_calendar_oauth_states WHERE expires_at < NOW()");
  await pool.query(
    "INSERT INTO public.google_calendar_oauth_states (state_hash, admin_uid, verifier_encrypted, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')",
    [sha256(state), uid, criptografarCalendarToken(verifier, cfg.key)],
  );
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", "openid email " + SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", sha256(verifier, "base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function trocarCodigo(code, verifier, cfg, fetcher) {
  return solicitarGoogle(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, code_verifier: verifier, client_id: cfg.clientId,
      client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  }, fetcher);
}

async function renovar(refreshToken, cfg, fetcher) {
  return solicitarGoogle(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: cfg.clientId,
      client_secret: cfg.clientSecret, grant_type: "refresh_token",
    }),
  }, fetcher);
}

async function callbackOAuth(req, res, pool, cfg, fetcher) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const state = params.get("state") || "";
  const code = params.get("code") || "";
  if (!/^[A-Za-z0-9_-]{35,120}$/.test(state)) {
    return responderPagina(res, 400, "Autorizacao invalida", "Inicie uma nova conexao.");
  }
  // Delete/returning atomico: expira, rejeita repeticao e nao reaproveita o codigo.
  const pending = await pool.query(
    "DELETE FROM public.google_calendar_oauth_states WHERE state_hash = $1 AND expires_at > NOW() RETURNING admin_uid, verifier_encrypted",
    [sha256(state)],
  );
  if (!pending.rows[0]) {
    return responderPagina(res, 400, "Autorizacao expirada", "Esta solicitacao ja foi usada ou expirou.");
  }
  if (params.get("error")) {
    return responderPagina(res, 400, "Autorizacao cancelada", "Nenhuma permissao foi alterada.");
  }
  if (!code || code.length > 2048) {
    return responderPagina(res, 400, "Autorizacao invalida", "O Google nao retornou codigo valido.");
  }
  const verifier = descriptografarCalendarToken(pending.rows[0].verifier_encrypted, cfg.key);
  const tokens = await trocarCodigo(code, verifier, cfg, fetcher);
  if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string" ||
      !tokens.access_token || !tokens.refresh_token) {
    throw erro("TOKEN_OFFLINE_AUSENTE", "Google nao concedeu acesso offline.", 502);
  }
  await validarEmailGoogle(tokens.access_token, cfg, fetcher);
  await leituraGoogle(tokens.access_token, cfg, fetcher);

  // Salvar SOMENTE refresh token criptografado; access token nao persiste.
  await pool.query(
    "INSERT INTO public.google_calendar_oauth_credentials (connection_name, google_email, refresh_token_encrypted, connected_by_uid, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (connection_name) DO UPDATE SET google_email = EXCLUDED.google_email, refresh_token_encrypted = EXCLUDED.refresh_token_encrypted, connected_by_uid = EXCLUDED.connected_by_uid, updated_at = NOW()",
    [CONNECTION, cfg.expectedEmail,
      criptografarCalendarToken(tokens.refresh_token, cfg.key), pending.rows[0].admin_uid],
  );
  return responderPagina(res, 200, "Google Calendar conectado",
    "Acesso validado. Nenhum evento foi modificado.");
}

async function buscarCredencial(pool) {
  const q = await pool.query(
    "SELECT google_email, refresh_token_encrypted FROM public.google_calendar_oauth_credentials WHERE connection_name = $1",
    [CONNECTION],
  );
  return q.rows[0] || null;
}

async function verificarConexao(res, pool, cfg, fetcher) {
  const row = await buscarCredencial(pool);
  if (!row) throw erro("CONEXAO_AUSENTE", "Conta Google ainda nao autorizada.", 409);
  if (String(row.google_email).toLowerCase() !== cfg.expectedEmail) {
    throw erro("CONTA_DIVERGENTE", "Conta Google divergente da configuracao.", 409);
  }
  const refresh = descriptografarCalendarToken(row.refresh_token_encrypted, cfg.key);
  const tokens = await renovar(refresh, cfg, fetcher);
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw erro("TOKEN_GOOGLE_INVALIDO", "Nao foi possivel renovar a autorizacao.", 502);
  }
  await validarEmailGoogle(tokens.access_token, cfg, fetcher);
  await leituraGoogle(tokens.access_token, cfg, fetcher);
  if (tokens.refresh_token && typeof tokens.refresh_token === "string") {
    await pool.query(
      "UPDATE public.google_calendar_oauth_credentials SET refresh_token_encrypted = $2, updated_at = NOW() WHERE connection_name = $1",
      [CONNECTION, criptografarCalendarToken(tokens.refresh_token, cfg.key)],
    );
  }
  return responder(res, 200, { conectado: true, contaCorreta: true, leituraCalendar: true });
}

async function obterFirestore() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  }
  return getFirestore();
}

async function autorizarAdmin(req, dependencies) {
  let uid;
  try {
    uid = await (dependencies.verificarUsuario || verificarUsuario)(req);
  } catch {
    throw erro("NAO_AUTENTICADO", "Acesso nao autenticado.", 401);
  }
  const firestore = dependencies.firestore || await obterFirestore();
  const snapshot = await firestore.collection("usuarios").doc(uid).get();
  if (snapshot.data()?.role !== "admin" || snapshot.data()?.ativo !== true) {
    throw erro("ACESSO_NEGADO", "Acesso restrito a administracao.", 403);
  }
  return uid;
}

export async function atenderGoogleCalendarOAuth(req, res, pool, dependencies = {}) {
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    const cfg = configuracaoCalendarOAuth(dependencies.env || process.env);
    const fetcher = dependencies.fetcher || fetch;
    if (path === CALLBACK_PATH) {
      if (req.method !== "GET") return responderPagina(res, 405, "Metodo nao permitido", "Operacao recusada.");
      return await callbackOAuth(req, res, pool, cfg, fetcher);
    }
    const uid = await autorizarAdmin(req, dependencies);
    if (req.method === "POST" && path === "/oauth/google/connect") {
      return responder(res, 200, { authorizationUrl: await criarAutorizacao(pool, uid, cfg), expiraEmSegundos: 600 });
    }
    if (req.method === "GET" && path === "/oauth/google/status") {
      const row = await buscarCredencial(pool);
      return responder(res, 200, { configurado: true, conectado: Boolean(row), verificacaoPendente: Boolean(row) });
    }
    if (req.method === "GET" && path === "/oauth/google/check") {
      return await verificarConexao(res, pool, cfg, fetcher);
    }
    return responder(res, 405, { erro: "Metodo nao permitido." });
  } catch (e) {
    const codigo = e.codigo || "ERRO_INTEGRACAO_GOOGLE";
    console.error("[Calendar OAuth] " + codigo);
    if (path === CALLBACK_PATH) {
      return responderPagina(res, e.status || 503, "Conexao nao concluida",
        "Falha de autorizacao. Codigo interno: " + codigo + ".");
    }
    return responder(res, e.status || 503, {
      erro: e.codigo ? e.message : "Falha na integracao Google Calendar.", codigo,
    });
  }
}
