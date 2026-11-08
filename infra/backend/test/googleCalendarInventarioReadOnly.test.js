import test from "node:test";
import assert from "node:assert/strict";
import { criarAdaptadorGoogleCalendar } from "../src/googleCalendarEvents.js";
import { levantarConciliacaoCalendar } from "../src/googleCalendarInventarioReadOnly.js";

const FROM = "2026-12-01T00:00:00-03:00";
const TO = "2026-12-09T00:00:00-03:00";
function resposta(status, body = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
function adapter(resolver) {
  const reqs = [];
  const adaptador = criarAdaptadorGoogleCalendar({
    calendarId: "isabelemarianavieiralima@gmail.com",
    env: { GOOGLE_CALENDAR_OAUTH_ENABLED: "true" }, // escrita DESLIGADA
    obterAccessToken: async () => "token-ficticio",
    fetcher: async (url, opcoes) => {
      reqs.push({ url: String(url), ...opcoes });
      return resolver(new URL(url), opcoes);
    },
  });
  return { adaptador, reqs };
}

test("Google events.list somente GET, consulta fields sem PII e percorre paginas", async () => {
  const t = adapter((url) => resposta(200,
    url.searchParams.has("pageToken")
      ? { kind: "calendar#events", items: [{ id: "evento2" }] }
      : { kind: "calendar#events", items: [{ id: "evento1" }], nextPageToken: "seg" },
  ));
  const resultado = await t.adaptador.listarEventos({ inicio: FROM, fim: TO });
  assert.deepEqual(resultado, {
    eventos: [{ id: "evento1" }, { id: "evento2" }], paginas: 2, completo: true,
  });
  assert.deepEqual(t.reqs.map(x=>x.method), ["GET","GET"]);
  assert.equal(t.reqs[0].headers.Authorization, "Bearer token-ficticio");
  const u = new URL(t.reqs[0].url);
  assert.equal(u.searchParams.get("timeMin"), FROM);
  assert.equal(u.searchParams.get("timeMax"), TO);
  assert.equal(u.searchParams.get("singleEvents"), "true");
  assert.equal(u.searchParams.get("showDeleted"), "false");
  assert.equal(u.searchParams.get("maxResults"), "250");
  assert.ok(u.searchParams.get("fields").includes("iCalUID"));
  assert.ok(!u.searchParams.get("fields").includes("summary"));
  assert.ok(!u.searchParams.get("fields").includes("attendees"));
  assert.equal(new URL(t.reqs[1].url).searchParams.get("pageToken"), "seg");
});

test("janela invertida, fora do fuso ou maior que 31 dias nao acessa rede", async () => {
  const t = adapter(() => { throw Error("network call unexpected"); });
  for (const [inicio, fim] of [
    [TO, FROM],
    ["2026-12-01T00:00:00", TO],
    [FROM, "2027-02-01T00:00:00-03:00"],
  ]) {
    await assert.rejects(t.adaptador.listarEventos({ inicio, fim }));
  }
  assert.equal(t.reqs.length, 0);
});

test("token de pagina repetido nao gera loop", async () => {
  const t = adapter(() => resposta(200, { kind: "calendar#events", items: [], nextPageToken: "mesmo" }));
  await assert.rejects(t.adaptador.listarEventos({ inicio: FROM, fim: TO }),
    { codigo: "PAGINACAO_GOOGLE_INVALIDA" });
  assert.equal(t.reqs.length, 2);
});

test("dez paginas sem fim falham, sem devolver inventario parcial", async () => {
  let n = 0;
  const t = adapter(() => resposta(200, {
    kind: "calendar#events", items: [], nextPageToken: String(++n),
  }));
  await assert.rejects(t.adaptador.listarEventos({ inicio: FROM, fim: TO }),
    { codigo: "INVENTARIO_CALENDAR_INCOMPLETO" });
  assert.equal(t.reqs.length, 10);
});

test("mais de 1500 eventos falha, evitando falso resultado incompleto", async () => {
  let n = 0;
  const t = adapter(() => resposta(200, {
    kind: "calendar#events",
    items: Array(250).fill(null).map((_, i) => ({ id: "e" + n + i })),
    nextPageToken: String(++n),
  }));
  await assert.rejects(t.adaptador.listarEventos({ inicio: FROM, fim: TO }),
    { codigo: "INVENTARIO_CALENDAR_EXCEDE_LIMITE" });
  assert.equal(t.reqs.length, 7);
});

test("falha do Google e formato incompleto nao produzem relatorio", async () => {
  const invalido = adapter(() => resposta(200, { items: [] }));
  await assert.rejects(invalido.adaptador.listarEventos({ inicio: FROM, fim: TO }),
    { codigo: "LISTAGEM_GOOGLE_INVALIDA" });
  const indisponivel = adapter(() => resposta(403));
  await assert.rejects(indisponivel.adaptador.listarEventos({ inicio: FROM, fim: TO }),
    { codigo: "GOOGLE_CALENDAR_HTTP_403" });
});

function fontes({ google, docs = [], pix = [], links = [], env } = {}) {
  const consultas = [];
  const firestore = { collection(name) {
    assert.equal(name, "agendamentos");
    const query = { where() { return query; }, limit(n) { assert.equal(n, 4001); return query; },
      async get() { consultas.push("FIRESTORE_GET"); return { docs: docs.map(doc => ({
        id: doc.id, data: () => doc,
      })) }; } };
    return query;
  } };
  const pool = { async query(sql, params) {
    assert.match(sql, /^SELECT/);
    consultas.push("PG_SELECT");
    if (sql.includes("pix_calendar_outbox")) return { rows: pix };
    if (sql.includes("google_calendar_event_links")) return { rows: links };
    throw Error("SQL inesperado");
  } };
  const adaptador = { async listarEventos() {
    consultas.push("GOOGLE_GET");
    return google || { completo: true, paginas: 1, eventos: [] };
  } };
  return { firestore, pool, adaptador, consultas, env: env ?? {
    GOOGLE_CALENDAR_AUDIT_ENABLED: "true",
    GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "false",
  } };
}
const args = { inicio: "2026-12-01", fim: "2026-12-09",
  calendarId: "isabelemarianavieiralima@gmail.com" };

test("inventario cruza as tres fontes apenas por SELECT/GET e nao salva vinculos", async () => {
  const f = fontes({
    docs: [{ id: "ag01", calendarEventId: "evento1", nomeCliente: "Nao imprimir" }],
    pix: [{ agendamento_id: "ag01", event_id: "legacy@google.com" }],
    links: [],
    google: { completo: true, paginas: 2,
      eventos: [{ id: "evento1", iCalUID: "legacy@google.com" }] },
  });
  const relatorio = await levantarConciliacaoCalendar({ ...args, ...f });
  assert.equal(relatorio.resumo.situacoes.candidato_legado, 1);
  assert.equal(relatorio.gerouVinculos, false);
  assert.equal(relatorio.nenhumaAlteracaoRealizada, true);
  assert.deepEqual(relatorio.fontes, { firestore: 1, pixOutbox: 1,
    vinculosConfirmados: 0, paginasGoogle: 2 });
  assert.deepEqual(f.consultas.sort(), ["FIRESTORE_GET","GOOGLE_GET","PG_SELECT","PG_SELECT"].sort());
  assert.ok(!JSON.stringify(relatorio).includes("Nao imprimir"));
});

test("auditoria desligada ou escrita ligada bloqueiam sem consultar nenhuma fonte", async () => {
  for (const env of [
    {},
    { GOOGLE_CALENDAR_AUDIT_ENABLED: "true", GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true" },
  ]) {
    const f = fontes({ env });
    await assert.rejects(levantarConciliacaoCalendar({ ...args, ...f }),
      { codigo: "AUDITORIA_DESATIVADA" });
    assert.equal(f.consultas.length, 0);
  }
});

test("janela maior que 30 dias ou data incorreta bloqueiam sem conexao", async () => {
  for (const datas of [
    { inicio: "2026-12-01", fim: "2027-02-01" },
    { inicio: "2026-02-30", fim: "2026-03-01" },
    { inicio: "2026-12-09", fim: "2026-12-01" },
  ]) {
    const f = fontes();
    await assert.rejects(levantarConciliacaoCalendar({ ...args, ...datas, ...f }));
    assert.equal(f.consultas.length, 0);
  }
});

test("fontes incompletas bloqueiam qualquer relatorio", async () => {
  const f = fontes({ google: { completo: false, paginas: 10, eventos: [] } });
  await assert.rejects(levantarConciliacaoCalendar({ ...args, ...f }),
    { codigo: "INVENTARIO_INCOMPLETO" });
  const muitos = fontes({ pix: Array(4001).fill({
    agendamento_id: "ag01", event_id: "x",
  }) });
  await assert.rejects(levantarConciliacaoCalendar({ ...args, ...muitos }),
    { codigo: "INVENTARIO_INCOMPLETO" });
});
