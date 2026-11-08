import test from "node:test";
import assert from "node:assert/strict";
import { gerarIdEventoGoogle } from "../src/googleCalendarEvents.js";
import { verificarOperacaoGoogleIncerta } from "../src/googleCalendarRecuperacaoIncerta.js";

const AG = "agendamento-incerto";
const EVENT = gerarIdEventoGoogle(AG);
const OP = "00000000-0000-4000-8000-000000000099";
const FP = "e".repeat(64);
const CAL = "isabelemarianavieiralima@gmail.com";
const FLAGS = { GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ENABLED: "true" };
const remote = {
  id: EVENT, status: "confirmed",
  extendedProperties: { private: {
    isabeleAgendamentoId: AG, isabeleOrigem: "isabele-vps",
  } },
};

function setup({
  evento = remote, estado = "aguardando_confirmacao",
  tipo = "criar", googleEventId = null, fingerprint = FP,
} = {}) {
  const chamadas = [];
  const op = { operation_id: OP, agendamento_id: AG,
    calendar_id: CAL, tipo, google_event_id: googleEventId,
    fingerprint_pedido: fingerprint, estado };
  let link = null;
  const pool = {
    async query(sql, args) {
      chamadas.push({ tipo: "SQL_READ", sql, args });
      return { rows: [op] };
    },
    async connect() {
      chamadas.push({ tipo: "PG_CONNECT" });
      return {
        async query(sql, args) {
          chamadas.push({ tipo: "SQL_TRANSACTION", sql, args });
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
          if (sql.startsWith("SELECT operation_id")) return { rows: [op] };
          if (sql.startsWith("INSERT INTO public.google_calendar_event_links")) {
            link = { agendamento_id: AG, calendar_id: CAL,
              google_event_id: EVENT, origem: "vps", situacao: "ativo" };
            return { rows: [] };
          }
          if (sql.startsWith("SELECT agendamento_id")) return { rows: link ? [link] : [] };
          if (sql.startsWith("UPDATE public.google_calendar_sync_operations")) {
            op.estado = "concluida"; op.google_event_id = EVENT;
            return { rows: [{ operation_id: OP }] };
          }
          throw Error("SQL nao esperado no mock");
        },
        release() { chamadas.push({ tipo: "PG_RELEASE" }); },
      };
    },
  };
  const adaptador = {
    async consultarEvento({ eventId }) {
      chamadas.push({ tipo: "GOOGLE_GET", eventId });
      return evento;
    },
  };
  return { pool, adaptador, chamadas, op };
}
const executar = (t, extras={}) => verificarOperacaoGoogleIncerta({
  pool: t.pool, adaptador: t.adaptador, operationId: OP,
  fingerprint: FP, calendarId: CAL, env: FLAGS, ...extras,
});

test("escritas globais desligadas rejeitam antes do banco e Google", async () => {
  const t = setup();
  await assert.rejects(executar(t, { env: { GOOGLE_CALENDAR_OAUTH_ENABLED: "true" } }),
    { codigo: "CUTOVER_DESATIVADO" });
  assert.equal(t.chamadas.length, 0);
});

test("se GET Google 404, nao repete insert nem fecha operacao", async () => {
  const t = setup({ evento: null });
  const res = await executar(t);
  assert.equal(res.estado, "ainda_sem_confirmacao");
  assert.equal(res.aguardandoRevisao, true);
  assert.equal(res.repetiuEscrita, false);
  assert.equal(t.op.estado, "aguardando_confirmacao");
  assert.deepEqual(t.chamadas.map(x=>x.tipo), ["SQL_READ", "GOOGLE_GET"]);
  assert.equal(t.chamadas[1].eventId, EVENT);
});

test("GET Google confirmado permite fechar PG sem POST/PATCH/DELETE", async () => {
  const t = setup();
  const res = await executar(t);
  assert.equal(res.estado, "confirmada_no_google");
  assert.equal(res.concluida, true);
  assert.equal(res.criouEvento, false);
  assert.equal(t.op.estado, "concluida");
  assert.deepEqual(t.chamadas.filter(x=>x.tipo === "GOOGLE_GET").map(x=>x.eventId), [EVENT]);
  assert.equal(t.chamadas.filter(x=>x.tipo === "SQL_TRANSACTION" && x.sql === "COMMIT").length, 1);
  assert.equal(t.chamadas.filter(x=>x.tipo === "SQL_TRANSACTION" && x.sql.startsWith("INSERT")).length, 1);
});

test("evento Google alheio nao e usado para concluir a operacao", async () => {
  const t = setup({ evento: {
    ...remote, extendedProperties: { private: {
      isabeleAgendamentoId: "outra-reserva", isabeleOrigem: "isabele-vps",
    } },
  } });
  await assert.rejects(executar(t), { codigo: "EVENTO_NAO_VERIFICADO" });
  assert.equal(t.op.estado, "aguardando_confirmacao");
  assert.equal(t.chamadas.filter(x=>x.tipo === "SQL_TRANSACTION" && x.sql === "ROLLBACK").length, 1);
});

test("estado pendente, conflito ou concluido bloqueiam recuperacao arbitraria", async () => {
  for (const estado of ["pendente", "processando", "conflito", "concluida"]) {
    const t = setup({ estado });
    await assert.rejects(executar(t), { codigo: "OPERACAO_ESTADO_INCOMPATIVEL" });
    assert.equal(t.chamadas.filter(x=>x.tipo === "GOOGLE_GET").length, 0);
  }
});

test("DELETE/cancelamento nao pode ser confirmado por operacao de GET", async () => {
  const t = setup({ tipo: "cancelar", googleEventId: EVENT });
  await assert.rejects(executar(t), { codigo: "TIPO_RECUPERACAO_NAO_SUPORTADO" });
  assert.equal(t.chamadas.filter(x=>x.tipo === "GOOGLE_GET").length, 0);
});

test("reagendamento exige ID persistido; criacao deve usar ID deterministico", async () => {
  const a = setup({ tipo: "reagendar" });
  await assert.rejects(executar(a), { codigo: "EVENTO_DIVERGENTE" });
  const b = setup({ googleEventId: "outroevento123" });
  await assert.rejects(executar(b), { codigo: "EVENTO_DIVERGENTE" });
  assert.equal(b.chamadas.some(x=>x.tipo==="GOOGLE_GET"), false);
});

test("fingerprint divergente nao envia requisicao Google", async () => {
  const t = setup({ fingerprint: "0".repeat(64) });
  await assert.rejects(executar(t), { codigo: "OPERACAO_DIVERGENTE" });
  assert.equal(t.chamadas.filter(x=>x.tipo === "GOOGLE_GET").length, 0);
});
