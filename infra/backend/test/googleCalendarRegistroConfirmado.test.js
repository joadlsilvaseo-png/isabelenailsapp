import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gerarIdEventoGoogle } from "../src/googleCalendarEvents.js";
import { concluirOperacaoGoogleConfirmada } from "../src/googleCalendarRegistroConfirmado.js";

const AG = "agendamento-001";
const CAL = "isabelemarianavieiralima@gmail.com";
const FP = "a".repeat(64);
const EVENT_ID = gerarIdEventoGoogle(AG);
const FLAGS = {
  GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ENABLED: "true",
};
function evento(id = EVENT_ID, aid = AG) {
  return { id, status: "confirmed",
    extendedProperties: { private: { isabeleAgendamentoId: aid, isabeleOrigem: "isabele-vps" } } };
}
function fakeDb({
  tipo = "criar", estado = "processando", googleEventId = null,
  previo = null, colisao = false, fingerprint = FP,
} = {}) {
  const id = randomUUID(), chamadas = [];
  const op = { operation_id: id, agendamento_id: AG, calendar_id: CAL, tipo,
    google_event_id: googleEventId, fingerprint_pedido: fingerprint, estado };
  let link = previo, releaseCount = 0;
  const con = {
    async query(sql, args = []) {
      chamadas.push({ sql, args });
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [] };
      if (sql.startsWith("SELECT operation_id")) return { rows: [op] };
      if (sql.startsWith("SELECT agendamento_id")) return { rows: link ? [link] : [] };
      if (sql.startsWith("SELECT google_event_id")) return { rows: link ? [link] : [] };
      if (sql.startsWith("INSERT INTO public.google_calendar_event_links")) {
        if (!colisao && !link) link = {
          agendamento_id: AG, calendar_id: CAL, google_event_id: args[2], origem: "vps", situacao: "ativo",
        };
        return { rowCount: link ? 1 : 0, rows: [] };
      }
      if (sql.startsWith("UPDATE public.google_calendar_sync_operations")) {
        op.estado = "concluida";
        op.google_event_id = args[1];
        return { rows: [{ operation_id: id }] };
      }
      throw Error("SQL unexpected");
    },
    release() { releaseCount++; },
  };
  return {
    id, op, chamadas,
    get link() { return link; }, get released() { return releaseCount; },
    pool: { connect: async () => con },
  };
}
const call = (t, override = {}) =>
  concluirOperacaoGoogleConfirmada({ pool: t.pool, operationId: t.id,
    fingerprint: FP, evento: evento(), calendarId: CAL, env: FLAGS, ...override });

test("sem cutover ou escrita desativada nao abre sequer transacao", async () => {
  const t = fakeDb();
  for (const env of [{}, { GOOGLE_CALENDAR_OAUTH_ENABLED: "true" },
    { GOOGLE_CALENDAR_OAUTH_ENABLED: "true", GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true" }]) {
    await assert.rejects(call(t, { env }), { codigo: "CUTOVER_DESATIVADO" });
  }
  assert.equal(t.chamadas.length, 0);
});

test("criacao confirmada grava vinculo e conclui operacao na mesma transacao", async () => {
  const t = fakeDb();
  const res = await call(t);
  assert.deepEqual(res, { concluida: true, repetida: false, agendamentoId: AG, googleEventId: EVENT_ID });
  assert.equal(t.link.google_event_id, EVENT_ID);
  assert.equal(t.op.estado, "concluida");
  assert.equal(t.chamadas.at(-1).sql, "COMMIT");
  assert.equal(t.released, 1);
  assert.equal(t.chamadas.filter(x=>x.sql==="BEGIN").length, 1);
  assert.equal(t.chamadas.filter(x=>x.sql==="COMMIT").length, 1);
  assert.equal(t.chamadas.filter(x=>x.sql==="ROLLBACK").length, 0);
});

test("reexecucao conclui idempotentemente sem inserir ou atualizar", async () => {
  const t = fakeDb();
  await call(t);
  const anterior = t.chamadas.length;
  const retorno = await call(t);
  assert.equal(retorno.repetida, true);
  assert.equal(t.chamadas.slice(anterior).filter(x=>x.sql.startsWith("INSERT")).length, 0);
  assert.equal(t.chamadas.slice(anterior).filter(x=>x.sql.startsWith("UPDATE")).length, 0);
  assert.equal(t.released, 2);
});

test("evento de outra reserva falha sem insert e faz ROLLBACK", async () => {
  const t = fakeDb();
  await assert.rejects(call(t, { evento: evento(EVENT_ID, "outra") }),
    { codigo: "EVENTO_NAO_VERIFICADO" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
  assert.equal(t.link, null);
  assert.equal(t.released, 1);
});

test("criacao com id nao deterministico nao confirma", async () => {
  const t = fakeDb();
  await assert.rejects(call(t, { evento: evento("outroevento") }),
    { codigo: "EVENTO_ID_NAO_DETERMINISTICO" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
});

test("fingerprint ou calendario divergente bloqueia antes do insert", async () => {
  const t = fakeDb();
  await assert.rejects(call(t, { fingerprint: "b".repeat(64) }),
    { codigo: "OPERACAO_DIVERGENTE" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
  assert.equal(t.chamadas.some(x=>x.sql.startsWith("INSERT")), false);
});

test("estado pendente ou conflito nao pode confirmar", async () => {
  for(const estado of ["pendente","conflito","falha_permanente","dispensada"]) {
    const t = fakeDb({ estado });
    await assert.rejects(call(t), { codigo: "OPERACAO_ESTADO_INCOMPATIVEL" });
    assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
  }
});

test("aguardando_confirmacao aceita resposta google posteriormente validada", async () => {
  const t = fakeDb({ estado: "aguardando_confirmacao" });
  assert.equal((await call(t)).concluida, true);
  assert.equal(t.chamadas.at(-1).sql, "COMMIT");
});

test("nao confirma cancelamento usando evento ainda existente", async () => {
  const t = fakeDb({ tipo: "cancelar", googleEventId: EVENT_ID });
  await assert.rejects(call(t), { codigo: "TIPO_NAO_IMPLEMENTADO" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
});

test("reagendar exige vinculo anterior VPS, nao associa legado automaticamente", async () => {
  const sem = fakeDb({ tipo: "reagendar", googleEventId: EVENT_ID });
  await assert.rejects(call(sem), { codigo: "VINCULO_PREEXISTENTE_AUSENTE" });
  assert.equal(sem.chamadas.some(x=>x.sql.startsWith("INSERT")), false);
  const comLink = fakeDb({
    tipo: "reagendar", googleEventId: EVENT_ID,
    previo: { agendamento_id: AG, calendar_id: CAL, google_event_id: EVENT_ID,
      origem: "vps", situacao: "ativo" },
  });
  assert.equal((await call(comLink)).concluida, true);
});

test("nao permite reaproveitar vinculo legado mesmo com evento bem marcado", async () => {
  const t = fakeDb({
    tipo: "alterar_servico", googleEventId: EVENT_ID,
    previo: { agendamento_id: AG, calendar_id: CAL, google_event_id: EVENT_ID,
      origem: "legado_validado", situacao: "ativo" },
  });
  await assert.rejects(call(t), { codigo: "VINCULO_PREEXISTENTE_AUSENTE" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
});

test("colisao de evento/AG nunca substitui outro vinculo", async () => {
  const t = fakeDb({ previo: {
    agendamento_id: AG, calendar_id: CAL, google_event_id: "outraeventoid",
    origem: "vps", situacao: "ativo",
  } });
  await assert.rejects(call(t), { codigo: "VINCULO_CONFLITANTE" });
  assert.equal(t.link.google_event_id, "outraeventoid");
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
});

test("estado concluido com vinculo divergente falha fechado", async () => {
  const t = fakeDb({ estado: "concluida", googleEventId: EVENT_ID });
  await assert.rejects(call(t), { codigo: "RESULTADO_CONCLUIDO_DIVERGENTE" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
});

test("comprovante sem status confirmed ou cancelado nao pode concluir", async () => {
  for (const status of [undefined, "cancelled", "tentative"]) {
    const t = fakeDb();
    const google = evento();
    if (status === undefined) delete google.status;
    else google.status = status;
    await assert.rejects(call(t, { evento: google }), { codigo: "EVENTO_NAO_CONFIRMADO" });
    assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
    assert.equal(t.link, null);
  }
});

test("repeticao nao confirma evento associado a vinculo cancelado", async () => {
  const t = fakeDb({
    estado: "concluida", googleEventId: EVENT_ID,
    previo: { agendamento_id: AG, google_event_id: EVENT_ID,
      calendar_id: CAL, origem: "vps", situacao: "cancelado" },
  });
  await assert.rejects(call(t), { codigo: "RESULTADO_CONCLUIDO_DIVERGENTE" });
  assert.equal(t.chamadas.at(-1).sql, "ROLLBACK");
});
