import test from "node:test";
import assert from "node:assert/strict";
import { criarAdaptadorGoogleCalendar, gerarIdEventoGoogle } from "../src/googleCalendarEvents.js";

const ENV = { GOOGLE_CALENDAR_OAUTH_ENABLED: "true", GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true" };
const DADOS = { agendamentoId: "agend-123", nomeCliente: "Cliente Exemplo",
  servico: "Unhas em gel", inicio: "2026-12-17T09:00:00-03:00", fim: "2026-12-17T11:00:00-03:00" };
const ID = gerarIdEventoGoogle(DADOS.agendamentoId);
const resposta = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const evento = ({ id = ID, agendamentoId = DADOS.agendamentoId, etag = '"v1"', vinculo = true } = {}) => ({
  id, etag, status: "confirmed",
  extendedProperties: { private: vinculo ? { isabeleAgendamentoId: agendamentoId, isabeleOrigem: "isabele-vps" } : {} },
});
function setup(resolver, env = ENV) {
  const chamadas = []; let tokens = 0;
  const adaptador = criarAdaptadorGoogleCalendar({
    calendarId: "isabelemarianavieiralima@gmail.com", env,
    obterAccessToken: async () => { tokens++; return "token-ficticio"; },
    fetcher: async (url, opcoes) => {
      chamadas.push({ url: String(url), ...opcoes });
      return resolver(String(url), opcoes, chamadas);
    },
  });
  return { adaptador, chamadas, get tokens() { return tokens; } };
}

test("ID deterministico e permitido na API Google", () => {
  assert.match(ID, /^[a-v0-9]{5,1024}$/);
  assert.equal(ID, gerarIdEventoGoogle(DADOS.agendamentoId));
  assert.notEqual(ID, gerarIdEventoGoogle("outro-agendamento"));
  assert.throws(() => gerarIdEventoGoogle("../../invalido"), { codigo: "AGENDAMENTO_ID_INVALIDO" });
});
test("escrita desativada nao consulta credenciais ou Google", async () => {
  const t = setup(() => resposta(404), { GOOGLE_CALENDAR_OAUTH_ENABLED: "true" });
  await assert.rejects(t.adaptador.criarEvento(DADOS), { codigo: "CALENDAR_ESCRITA_DESATIVADA" });
  await assert.rejects(t.adaptador.atualizarEvento({ ...DADOS, eventId: ID }),
    { codigo: "CALENDAR_ESCRITA_DESATIVADA" });
  await assert.rejects(t.adaptador.excluirEvento({ agendamentoId: DADOS.agendamentoId, eventId: ID }),
    { codigo: "CALENDAR_ESCRITA_DESATIVADA" });
  assert.equal(t.chamadas.length, 0);
  assert.equal(t.tokens, 0);
  assert.equal(await t.adaptador.consultarEvento({ eventId: ID }), null);
  const semOAuth = setup(() => resposta(201, evento()), { GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true" });
  await assert.rejects(semOAuth.adaptador.criarEvento(DADOS), { codigo: "CALENDAR_ESCRITA_DESATIVADA" });
  assert.equal(semOAuth.chamadas.length, 0);
});
test("POST usa ID fixo, fuso, identificacao privada e sem notificar convidados", async () => {
  const t = setup(() => resposta(201, evento()));
  assert.deepEqual(await t.adaptador.criarEvento(DADOS),
    { eventId: ID, criado: true, etag: '"v1"' });
  assert.equal(t.chamadas.length, 1);
  const c = t.chamadas[0], body = JSON.parse(c.body);
  assert.equal(c.method, "POST");
  assert.equal(new URL(c.url).searchParams.get("sendUpdates"), "none");
  assert.equal(c.headers.Authorization, "Bearer token-ficticio");
  assert.equal(body.id, ID);
  assert.equal(body.summary, "Unhas em gel - Cliente Exemplo");
  assert.equal(body.start.dateTime, DADOS.inicio);
  assert.equal(body.end.dateTime, DADOS.fim);
  assert.equal(body.start.timeZone, "America/Sao_Paulo");
  assert.deepEqual(body.extendedProperties.private,
    { isabeleAgendamentoId: DADOS.agendamentoId, isabeleOrigem: "isabele-vps" });
});
test("POST 409 recupera mesmo evento, nao duplica", async () => {
  const t = setup((url, ops) => ops.method === "POST" ? resposta(409) : resposta(200, evento()));
  const result = await t.adaptador.criarEvento(DADOS);
  assert.equal(result.criado, false);
  assert.equal(result.eventId, ID);
  assert.deepEqual(t.chamadas.map(x => x.method), ["POST", "GET"]);
});
test("POST 409 nao aceita evento alheio nem colisao ainda invisivel", async () => {
  const t = setup((url, ops) => ops.method === "POST" ? resposta(409)
    : resposta(200, evento({ agendamentoId: "outro-id" })));
  await assert.rejects(t.adaptador.criarEvento(DADOS), { codigo: "EVENTO_SEM_VINCULO" });
  assert.deepEqual(t.chamadas.map(x => x.method), ["POST", "GET"]);
  const indefinido = setup((url, ops) => ops.method === "POST" ? resposta(409) : resposta(404));
  await assert.rejects(indefinido.adaptador.criarEvento(DADOS),
    { codigo: "GOOGLE_CALENDAR_CONFLITO_INDEFINIDO" });
});
test("timeout da criacao nao repete automaticamente", async () => {
  const t = setup(async () => { throw Error("timeout"); });
  await assert.rejects(t.adaptador.criarEvento(DADOS), { codigo: "GOOGLE_CALENDAR_SEM_CONFIRMACAO" });
  assert.deepEqual(t.chamadas.map(x => x.method), ["POST"]);
  assert.equal(gerarIdEventoGoogle(DADOS.agendamentoId), ID);
});
test("PATCH verifica ownership e usa etag / If-Match", async () => {
  const t = setup((url, ops) => ops.method === "GET" ? resposta(200, evento())
    : resposta(200, evento({ etag: '"v2"' })));
  const result = await t.adaptador.atualizarEvento({
    ...DADOS, eventId: ID, inicio: "2026-12-17T10:00:00-03:00",
    fim: "2026-12-17T12:00:00-03:00",
  });
  assert.deepEqual(result, { eventId: ID, atualizado: true, etag: '"v2"' });
  assert.deepEqual(t.chamadas.map(x => x.method), ["GET", "PATCH"]);
  assert.equal(t.chamadas[1].headers["If-Match"], '"v1"');
  assert.equal(new URL(t.chamadas[1].url).searchParams.get("sendUpdates"), "none");
  assert.equal(JSON.parse(t.chamadas[1].body).start.dateTime, "2026-12-17T10:00:00-03:00");
  assert.equal(Object.hasOwn(JSON.parse(t.chamadas[1].body), "extendedProperties"), false);
});
test("PATCH impede alteracao alheia e nao atualiza sem etag", async () => {
  const t = setup(() => resposta(200, evento({ vinculo: false })));
  await assert.rejects(t.adaptador.atualizarEvento({ ...DADOS, eventId: ID }), { codigo: "EVENTO_SEM_VINCULO" });
  assert.deepEqual(t.chamadas.map(x => x.method), ["GET"]);
  const noEtag = setup(() => resposta(200, evento({ etag: "" })));
  await assert.rejects(noEtag.adaptador.atualizarEvento({ ...DADOS, eventId: ID }), { codigo: "ETAG_GOOGLE_AUSENTE" });
});
test("PATCH interrompe em 412 sem sobrescrever evento alterado", async () => {
  const t = setup((url, ops) => ops.method === "GET" ? resposta(200, evento()) : resposta(412));
  await assert.rejects(t.adaptador.atualizarEvento({ ...DADOS, eventId: ID }),
    { codigo: "GOOGLE_CALENDAR_CONFLITO_VERSAO" });
  assert.deepEqual(t.chamadas.map(x => x.method), ["GET", "PATCH"]);
});
test("DELETE verifica vinculo e versao do evento", async () => {
  const t = setup((url, ops) => ops.method === "GET" ? resposta(200, evento()) : resposta(204));
  assert.deepEqual(await t.adaptador.excluirEvento({ agendamentoId: DADOS.agendamentoId, eventId: ID }),
    { eventId: ID, excluido: true, jaAusente: false });
  assert.deepEqual(t.chamadas.map(x => x.method), ["GET", "DELETE"]);
  assert.equal(t.chamadas[1].headers["If-Match"], '"v1"');
  assert.equal(t.chamadas[1].body, undefined);
  const alheio = setup(() => resposta(200, evento({ agendamentoId: "outra" })));
  await assert.rejects(alheio.adaptador.excluirEvento({ agendamentoId: DADOS.agendamentoId, eventId: ID }),
    { codigo: "EVENTO_SEM_VINCULO" });
  assert.deepEqual(alheio.chamadas.map(x => x.method), ["GET"]);
});
test("DELETE repetido sem evento e idempotente", async () => {
  const t = setup(() => resposta(404));
  assert.deepEqual(await t.adaptador.excluirEvento({ agendamentoId: DADOS.agendamentoId, eventId: ID }),
    { eventId: ID, excluido: false, jaAusente: true });
  assert.deepEqual(t.chamadas.map(x => x.method), ["GET"]);
});
test("HTTP 403 nao revela detalhes; datas invalidas nao acionam rede", async () => {
  const t = setup(() => resposta(403));
  await assert.rejects(t.adaptador.consultarEvento({ eventId: ID }), { codigo: "GOOGLE_CALENDAR_HTTP_403" });
  for (const campo of [
    { inicio: "2026-12-17T09:00:00" },
    { inicio: "2026-02-30T09:00:00-03:00" },
    { fim: "2026-12-17T08:00:00-03:00" },
    { nomeCliente: "" },
  ]) {
    const invalid = setup(() => { throw Error("nao deve chegar"); });
    await assert.rejects(invalid.adaptador.criarEvento({ ...DADOS, ...campo }));
    assert.equal(invalid.chamadas.length, 0);
  }
});
test("resposta inesperada do POST nao confirma a criacao", async () => {
  const t = setup(() => resposta(201, evento({ id: gerarIdEventoGoogle("outro-agendamento") })));
  await assert.rejects(t.adaptador.criarEvento(DADOS), { codigo: "EVENTO_NAO_CONFIRMADO" });
  assert.equal(t.chamadas.length, 1);
});

test("evento cancelado nao pode ser reativado por PATCH; DELETE nao repete", async () => {
  const cancelado = setup(() => resposta(200, { ...evento(), status: "cancelled" }));
  await assert.rejects(cancelado.adaptador.atualizarEvento({ ...DADOS, eventId: ID }),
    { codigo: "EVENTO_GOOGLE_CANCELADO" });
  assert.deepEqual(cancelado.chamadas.map(x => x.method), ["GET"]);
  assert.deepEqual(
    await cancelado.adaptador.excluirEvento({ agendamentoId: DADOS.agendamentoId, eventId: ID }),
    { eventId: ID, excluido: false, jaAusente: true },
  );
  assert.deepEqual(cancelado.chamadas.map(x => x.method), ["GET", "GET"]);
});

test("ISO com milissegundos UTC e aceito na criacao sem alterar instante", async () => {
  const data = { ...DADOS,
    inicio: "2026-12-22T07:00:00-03:00",
    fim: "2026-12-22T11:30:00.000Z",
  };
  const t = setup(() => resposta(201, evento()));
  await t.adaptador.criarEvento(data);
  assert.deepEqual(t.chamadas.map(x => x.method), ["POST"]);
  const body = JSON.parse(t.chamadas[0].body);
  assert.equal(Date.parse(body.end.dateTime) - Date.parse(body.start.dateTime), 90 * 60000);
  assert.equal(body.end.dateTime, data.fim);
});
test("ISO com fracao invalida continua bloqueado antes de acessar Google", async () => {
  for (const fim of ["2026-12-22T11:30:00.0000Z", "2026-12-22T11:30:00.abcZ",
    "2026-12-22T11:30:00.000", "2026-12-22T11:30:00.000+25:00"]) {
    const t = setup(() => { throw Error("nao chamar"); });
    await assert.rejects(t.adaptador.criarEvento({ ...DADOS, fim }), {
      codigo: "DATA_CALENDAR_INVALIDA",
    });
    assert.equal(t.chamadas.length, 0);
  }
});
