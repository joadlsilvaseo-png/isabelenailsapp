import test from "node:test";
import assert from "node:assert/strict";
import { criarAdaptadorGoogleCalendarComOAuth } from "../src/googleCalendarTokenProvider.js";
import {
  criptografarCalendarToken,
  descriptografarCalendarToken,
} from "../src/googleCalendarOAuth.js";

const EMAIL = "isabelemarianavieiralima@gmail.com";
const KEY = Buffer.alloc(32, 29);
const ENV = {
  GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_OAUTH_CLIENT_ID: "cliente-teste.apps.googleusercontent.com",
  GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: "segredo-ficticio",
  GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: "https://isabelenailsapi.duckdns.org/oauth/google/callback",
  GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: KEY.toString("base64url"),
  GOOGLE_CALENDAR_ID: EMAIL,
  GOOGLE_CALENDAR_EXPECTED_EMAIL: EMAIL,
};
const ID = "imn" + "1".repeat(64);

const resposta = (status, body = {}) => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
});

function cenario({
  registroEmail = EMAIL,
  tokenInicial = "refresh-original",
  tokenResposta = { access_token: "access-renovado", expires_in: 3600 },
  perfil = { email: EMAIL, email_verified: true },
  calendario = { kind: "calendar#events" },
  errosHttp = {},
  onRequest,
  env = ENV,
} = {}) {
  const registro = {
    google_email: registroEmail,
    refresh_token_encrypted: criptografarCalendarToken(tokenInicial, KEY),
  };
  const sql = [], http = [];
  let agora = 1_000_000;
  let atualizacoes = 0;

  const pool = {
    async query(query, params = []) {
      sql.push({ query, params });
      if (query.startsWith("SELECT google_email, refresh_token_encrypted")) {
        return { rows: registro.google_email ? [{ ...registro }] : [] };
      }
      if (query.startsWith("UPDATE public.google_calendar_oauth_credentials")) {
        if (registro.google_email !== params[2] ||
            registro.refresh_token_encrypted !== params[3]) return { rows: [] };
        registro.refresh_token_encrypted = params[0];
        atualizacoes++;
        return { rows: [{ connection_name: "isabele" }] };
      }
      throw Error("Consulta SQL nao esperada.");
    },
  };

  const fetcher = async (url, ops) => {
    const endereco = String(url);
    http.push({ url: endereco, ...ops });
    if (onRequest) await onRequest(endereco, ops, registro);
    if (errosHttp[endereco] === "network") throw Error("segredo sensivel em erro do fetch");
    if (Number.isInteger(errosHttp[endereco])) return resposta(errosHttp[endereco], { message: "nunca deve vazar" });
    if (endereco === "https://oauth2.googleapis.com/token") return resposta(200, tokenResposta);
    if (endereco === "https://openidconnect.googleapis.com/v1/userinfo") return resposta(200, perfil);
    if (endereco.includes("/calendar/v3/calendars/") && endereco.endsWith("/events/" + ID)) {
      return resposta(404);
    }
    if (endereco.includes("/calendar/v3/calendars/") && endereco.includes("?maxResults=")) {
      return resposta(200, calendario);
    }
    throw Error("URL nao esperada no mock: " + endereco);
  };

  const adaptador = criarAdaptadorGoogleCalendarComOAuth(pool, {
    env, fetcher, relogio: () => agora,
  });

  return {
    adaptador, sql, http, registro,
    get atualizacoes() { return atualizacoes; },
    avancar(ms) { agora += ms; },
    removerConexao() { registro.google_email = ""; },
  };
}

test("OAuth desligado falha fechado antes de consultar Postgres ou Google", () => {
  let consultas = 0;
  assert.throws(() => criarAdaptadorGoogleCalendarComOAuth({
    query: async () => { consultas++; return { rows: [] }; },
  }, { env: { ...ENV, GOOGLE_CALENDAR_OAUTH_ENABLED: "false" } }), {
    codigo: "INTEGRACAO_DESABILITADA",
  });
  assert.equal(consultas, 0);
});

test("nao existe conexao no PostgreSQL: nenhuma chamada ao Google", async () => {
  const t = cenario();
  t.removerConexao();
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_SEM_CONEXAO",
  });
  assert.equal(t.http.length, 0);
});

test("conta do banco divergente bloqueia antes de decifrar ou chamar Google", async () => {
  const t = cenario({ registroEmail: "outro@gmail.com" });
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_CONTA_DIVERGENTE",
  });
  assert.equal(t.http.length, 0);
});

test("chave incorreta impede acesso sem chamar endpoint Google", async () => {
  const t = cenario({ env: {
    ...ENV, GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString("base64url"),
  } });
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "TOKEN_INVALIDO",
  });
  assert.equal(t.http.length, 0);
});

test("renovacao usa POST seguro, confirma identidade, agenda e consulta somente leitura", async () => {
  const t = cenario();
  assert.equal(await t.adaptador.consultarEvento({ eventId: ID }), null);
  assert.equal(t.http.length, 4);
  assert.deepEqual(t.http.map(x => x.method), ["POST", "GET", "GET", "GET"]);
  assert.equal(t.http[0].url, "https://oauth2.googleapis.com/token");
  const body = new URLSearchParams(t.http[0].body);
  assert.deepEqual(Object.fromEntries(body.entries()), {
    refresh_token: "refresh-original",
    client_id: ENV.GOOGLE_CALENDAR_OAUTH_CLIENT_ID,
    client_secret: ENV.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  assert.equal(t.http[1].url, "https://openidconnect.googleapis.com/v1/userinfo");
  assert.ok(t.http[2].url.includes(encodeURIComponent(EMAIL)));
  assert.equal(new URL(t.http[2].url).searchParams.get("fields"), "kind");
  assert.equal(new URL(t.http[2].url).searchParams.get("maxResults"), "1");
  assert.equal(t.http[3].headers.Authorization, "Bearer access-renovado");
  assert.equal(t.sql.filter(x => x.query.startsWith("UPDATE")).length, 0);
  assert.equal(t.atualizacoes, 0);
  assert.ok(!JSON.stringify(t.sql).includes("access-renovado"));
});

test("cache em memoria evita novos refreshs por ate cinco minutos", async () => {
  const t = cenario();
  await t.adaptador.consultarEvento({ eventId: ID });
  const n = t.http.length;
  t.avancar(4 * 60 * 1000);
  await t.adaptador.consultarEvento({ eventId: ID });
  assert.equal(t.http.length, n + 1); // apenas GET do evento
  t.avancar(2 * 60 * 1000);
  await t.adaptador.consultarEvento({ eventId: ID });
  assert.equal(t.http.length, n + 1 + 4);
  assert.equal(t.http.filter(x => x.url.endsWith("/token")).length, 2);
});

test("renovacoes simultaneas compartilham uma chamada de token", async () => {
  const t = cenario();
  const resultados = await Promise.all([
    t.adaptador.consultarEvento({ eventId: ID }),
    t.adaptador.consultarEvento({ eventId: ID }),
    t.adaptador.consultarEvento({ eventId: ID }),
  ]);
  assert.deepEqual(resultados, [null, null, null]);
  assert.equal(t.http.filter(x => x.url.endsWith("/token")).length, 1);
  assert.equal(t.sql.filter(x => x.query.startsWith("SELECT")).length, 2);
});

test("refresh token rotacionado e cifrado com CAS, nao altera identidade nem grava access token", async () => {
  const t = cenario({ tokenResposta: {
    access_token: "access-renovado", expires_in: 3600, refresh_token: "novo-refresh",
  } });
  await t.adaptador.consultarEvento({ eventId: ID });
  assert.equal(t.atualizacoes, 1);
  assert.equal(descriptografarCalendarToken(t.registro.refresh_token_encrypted, KEY), "novo-refresh");
  assert.ok(!t.registro.refresh_token_encrypted.includes("novo-refresh"));
  assert.ok(!JSON.stringify(t.sql).includes("access-renovado"));
  assert.equal(t.registro.google_email, EMAIL);
  const atualizar = t.sql.find(x => x.query.startsWith("UPDATE"));
  assert.equal(atualizar.params.length, 4);
  assert.equal(atualizar.params[1], "isabele");
  assert.equal(atualizar.params[2], EMAIL);
});

test("rotacao nao sobrescreve uma conexao mais recente", async () => {
  const t = cenario({
    tokenResposta: { access_token: "access", expires_in: 3600, refresh_token: "novo" },
    onRequest: (url, ops, registro) => {
      if (url.includes("?maxResults=")) {
        registro.refresh_token_encrypted = criptografarCalendarToken("outra-autorizacao", KEY);
      }
    },
  });
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_CREDENCIAL_ALTERADA",
  });
  assert.equal(descriptografarCalendarToken(t.registro.refresh_token_encrypted, KEY), "outra-autorizacao");
  assert.equal(t.atualizacoes, 0);
});

test("sem rotacao, credencial alterada durante a renovacao nao e reutilizada", async () => {
  const t = cenario({
    onRequest: (url, ops, registro) => {
      if (url.includes("?maxResults=")) {
        registro.refresh_token_encrypted = criptografarCalendarToken("outra-autorizacao", KEY);
      }
    },
  });
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_CREDENCIAL_ALTERADA",
  });
});

test("resposta Google sem access token ou expiracao valida bloqueia", async () => {
  for (const tokens of [
    { expires_in: 3600 },
    { access_token: "x", expires_in: 0 },
    { access_token: "x" },
  ]) {
    const t = cenario({ tokenResposta: tokens });
    await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
      codigo: "CALENDAR_ACCESS_INVALIDO",
    });
    assert.equal(t.http.length, 1);
  }
});

test("Google exige mesmo e-mail verificado; nao consulta calendario em divergencia", async () => {
  for (const perfil of [
    { email: "outro@gmail.com", email_verified: true },
    { email: EMAIL, email_verified: false },
  ]) {
    const t = cenario({ perfil });
    await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
      codigo: "CALENDAR_CONTA_DIVERGENTE",
    });
    assert.equal(t.http.length, 2);
  }
});

test("calendario sem acesso ou resposta com formato errado bloqueia", async () => {
  const falha = cenario({ errosHttp: {
    ["https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(EMAIL) +
      "/events?maxResults=1&fields=kind"]: 403,
  } });
  await assert.rejects(falha.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_GOOGLE_REJEITOU",
  });
  const formato = cenario({ calendario: { kind: "other" } });
  await assert.rejects(formato.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_SEM_ACESSO",
  });
});

test("erro de rede nao expoe detalhes do fetch e tentativa seguinte pode renovar", async () => {
  const err = cenario({ errosHttp: { "https://oauth2.googleapis.com/token": "network" } });
  let error;
  try { await err.adaptador.consultarEvento({ eventId: ID }); } catch (e) { error = e; }
  assert.equal(error?.codigo, "CALENDAR_GOOGLE_INDISPONIVEL");
  assert.ok(!error.message.includes("segredo sensivel"));
  assert.equal(err.http.length, 1);
  const retry = cenario();
  assert.equal(await retry.adaptador.consultarEvento({ eventId: ID }), null);
});

test("mesmo com token em cache, desabilitar OAuth interrompe antes da rede", async () => {
  const env = { ...ENV };
  const t = cenario({ env });
  await t.adaptador.consultarEvento({ eventId: ID });
  env.GOOGLE_CALENDAR_OAUTH_ENABLED = "false";
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), {
    codigo: "CALENDAR_OAUTH_DESATIVADO",
  });
});

test("escrita direta continua desligada, sem consultas ao PG ou Google", async () => {
  const t = cenario();
  await assert.rejects(t.adaptador.criarEvento({
    agendamentoId: "teste", nomeCliente: "Cliente", servico: "Manicure",
    inicio: "2026-12-01T09:00:00-03:00", fim: "2026-12-01T10:00:00-03:00",
  }), { codigo: "CALENDAR_ESCRITA_DESATIVADA" });
  assert.equal(t.sql.length, 0);
  assert.equal(t.http.length, 0);
});
