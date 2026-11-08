import test from "node:test";
import assert from "node:assert/strict";
import {
  atenderGoogleCalendarOAuth, configuracaoCalendarOAuth,
  criptografarCalendarToken, descriptografarCalendarToken
} from "../src/googleCalendarOAuth.js";

const ADMIN = "admin-isabele", EMAIL = "isabelemarianavieiralima@gmail.com";
const REDIRECT = "https://isabelenailsapi.duckdns.org/oauth/google/callback";
const KEY = Buffer.alloc(32, 17);
const ENV = {
  GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "teste.apps.googleusercontent.com",
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "secret-ficticio",
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: REDIRECT,
  GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: KEY.toString("base64url"),
  GOOGLE_CALENDAR_ID: EMAIL, GOOGLE_CALENDAR_EXPECTED_EMAIL: EMAIL
};

function req(method, url) { return { method, url, headers: {} }; }
function res() {
  return {
    status: null, headers: {}, body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(data) { this.body = data || ""; },
    get json() { return JSON.parse(this.body); }
  };
}
function pool() {
  const states = new Map(), calls = [];
  let credential = null;
  return {
    states, calls,
    get credential() { return credential; },
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("expires_at < NOW()")) return { rows: [] };
      if (sql.startsWith("INSERT INTO public.google_calendar_oauth_states")) {
        states.set(params[0], { admin_uid: params[1], verifier_encrypted: params[2] });
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM public.google_calendar_oauth_states WHERE state_hash")) {
        const row = states.get(params[0]); states.delete(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("INSERT INTO public.google_calendar_oauth_credentials")) {
        credential = { google_email: params[1], refresh_token_encrypted: params[2] };
        return { rows: [] };
      }
      if (sql.startsWith("SELECT google_email")) return { rows: credential ? [credential] : [] };
      if (sql.startsWith("UPDATE public.google_calendar_oauth_credentials")) {
        credential.refresh_token_encrypted = params[1]; return { rows: [] };
      }
      throw Error("SQL inesperado: " + sql);
    }
  };
}
function fakeGoogle({ email = EMAIL, offline = true, allowed = true } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(options.body);
      if (body.get("grant_type") === "refresh_token")
        return { ok: true, json: async () => ({ access_token: "renovado" }) };
      assert.equal(body.get("redirect_uri"), REDIRECT);
      assert.ok(body.get("code_verifier"));
      return { ok: true, json: async () => ({
        access_token: "access-ficticio",
        ...(offline ? { refresh_token: "refresh-ficticio" } : {})
      }) };
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo")
      return { ok: true, json: async () => ({ email, email_verified: true }) };
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
      assert.equal(options.method, "GET");
      assert.match(url, /maxResults=1/);
      return allowed ? { ok: true, json: async () => ({ kind: "calendar#events" }) }
        : { ok: false, status: 403 };
    }
    throw Error("Endpoint nao permitido: " + url);
  };
  return { fetcher, calls };
}
function deps(g, extra = {}) {
  return {
    env: ENV, fetcher: g.fetcher, verificarUsuario: async () => ADMIN,
    firestore: { collection(name) {
      assert.equal(name, "usuarios");
      return { doc(uid) { return { get: async () => ({
        data: () => ({ role: uid === ADMIN ? "admin" : "cliente", ativo: true })
      }) }; } };
    } },
    ...extra
  };
}
async function start(p) {
  const g = fakeGoogle(), response = res();
  await atenderGoogleCalendarOAuth(req("POST", "/oauth/google/connect"), response, p, deps(g));
  assert.equal(response.status, 200);
  const url = new URL(response.json.authorizationUrl);
  return { state: url.searchParams.get("state"), url };
}
async function callback(p, state, g = fakeGoogle()) {
  const response = res();
  await atenderGoogleCalendarOAuth(
    req("GET", "/oauth/google/callback?state=" + state + "&code=codigo-ficticio"),
    response, p, deps(g));
  return response;
}

test("configuracao falha fechada e criptografia nao grava token em claro", () => {
  assert.throws(() => configuracaoCalendarOAuth({ ...ENV, GOOGLE_CALENDAR_OAUTH_ENABLED: "false" }),
    e => e.codigo === "INTEGRACAO_DESABILITADA");
  assert.throws(() => configuracaoCalendarOAuth({ ...ENV, GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: "fraca" }),
    e => e.codigo === "CONFIGURACAO_INCOMPLETA");
  const encrypted = criptografarCalendarToken("segredo", KEY);
  assert.ok(!encrypted.includes("segredo"));
  assert.equal(descriptografarCalendarToken(encrypted, KEY), "segredo");
  assert.throws(() => descriptografarCalendarToken(encrypted, Buffer.alloc(32, 2)),
    e => e.codigo === "TOKEN_INVALIDO");
});

test("flag desabilitada nao consulta base nem Google", async () => {
  const p = pool(), g = fakeGoogle(), response = res();
  await atenderGoogleCalendarOAuth(req("POST", "/oauth/google/connect"), response, p,
    deps(g, { env: { ...ENV, GOOGLE_CALENDAR_OAUTH_ENABLED: "false" } }));
  assert.equal(response.status, 503);
  assert.equal(p.calls.length, 0);
  assert.equal(g.calls.length, 0);
});

test("nao permite inicio para nao autenticado ou cliente", async () => {
  const p = pool(), g = fakeGoogle(), response1 = res(), response2 = res();
  await atenderGoogleCalendarOAuth(req("POST", "/oauth/google/connect"), response1, p,
    deps(g, { verificarUsuario: async () => { throw Error("sem token"); } }));
  await atenderGoogleCalendarOAuth(req("POST", "/oauth/google/connect"), response2, p,
    deps(g, { verificarUsuario: async () => "cliente" }));
  assert.equal(response1.status, 401);
  assert.equal(response2.status, 403);
  assert.equal(p.calls.length, 0);
});

test("inicio usa state, PKCE e permissao offline; PG guarda so o verificador cifrado", async () => {
  const p = pool(), { url, state } = await start(p);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("scope").includes("calendar.events"));
  assert.ok(url.searchParams.get("scope").includes("openid email"));
  assert.ok(state.length >= 40);
  assert.ok([...p.states.values()][0].verifier_encrypted.startsWith("v1."));
  assert.ok(!JSON.stringify([...p.states.entries()]).includes(state));
});

test("callback valida identidade, calendario e grava refresh criptografado sem eventos modificados", async () => {
  const p = pool(), { state } = await start(p), g = fakeGoogle();
  const response = await callback(p, state, g);
  assert.equal(response.status, 200);
  assert.match(response.body, /Google Calendar conectado/);
  assert.equal(p.credential.google_email, EMAIL);
  assert.equal(descriptografarCalendarToken(p.credential.refresh_token_encrypted, KEY), "refresh-ficticio");
  assert.ok(!p.credential.refresh_token_encrypted.includes("refresh-ficticio"));
  assert.equal(g.calls.filter(c => c.url.includes("/calendar/v3/")).length, 1);
  assert.ok(g.calls.every(c => !c.url.endsWith("/events/insert")));
  const repeat = await callback(p, state);
  assert.equal(repeat.status, 400);

  const status = res();
  await atenderGoogleCalendarOAuth(req("GET", "/oauth/google/status"), status, p, deps(g));
  assert.deepEqual(status.json, { configurado: true, conectado: true, verificacaoPendente: true });

  const check = res();
  await atenderGoogleCalendarOAuth(req("GET", "/oauth/google/check"), check, p, deps(g));
  assert.equal(check.status, 200);
  assert.equal(check.json.leituraCalendar, true);
  assert.equal(g.calls.filter(c => c.url.includes("/calendar/v3/")).length, 2);
});

test("conta errada, ausencia de refresh e calendario sem acesso bloqueiam gravacao", async () => {
  for (const options of [
    { email: "intruso@example.com" }, { offline: false }, { allowed: false }
  ]) {
    const p = pool(), { state } = await start(p);
    const response = await callback(p, state, fakeGoogle(options));
    assert.ok([403, 502].includes(response.status));
    assert.equal(p.credential, null);
  }
});

test("callback sem estado valido nao consulta banco e check sem OAuth nao funciona", async () => {
  const p = pool(), g = fakeGoogle(), response = res();
  await atenderGoogleCalendarOAuth(
    req("GET", "/oauth/google/callback?state=curto&code=x"), response, p, deps(g));
  assert.equal(response.status, 400);
  assert.equal(p.calls.length, 0);
  const check = res();
  await atenderGoogleCalendarOAuth(req("GET", "/oauth/google/check"), check, p, deps(g));
  assert.equal(check.status, 409);
});
