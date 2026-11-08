import test from "node:test";
import assert from "node:assert/strict";
import { conciliarEventosGoogle } from "../src/googleCalendarReconciliacao.js";

const ev = (id, other = {}) => ({
  id, status: "confirmed",
  extendedProperties: { private: {} },
  ...other,
});
const vps = (id, agendamentoId) => ev(id, {
  extendedProperties: { private: { isabeleAgendamentoId: agendamentoId, isabeleOrigem: "isabele-vps" } },
});
const link = (agendamento_id, google_event_id, origem = "legado_validado") =>
  ({ agendamento_id, google_event_id, origem });

test("nenhuma fonte produz relatorio vazio e nenhuma escrita", () => {
  const r = conciliarEventosGoogle({});
  assert.deepEqual(r.resumo, { agendamentos: 0, eventosGoogle: 0, eventosSemReferencia: 0, situacoes: {} });
  assert.equal(r.somenteLeitura, true);
  assert.equal(r.gerouVinculos, false);
});

test("ID exato Firestore gera candidato nao vinculo automatico", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", calendarEventId: "evento1" }],
    eventos: [ev("evento1")],
  });
  assert.equal(r.registros[0].situacao, "candidato_legado");
  assert.deepEqual(r.registros[0].candidatos[0].evidencias, ["id_exato"]);
  assert.equal(r.gerouVinculos, false);
});

test("iCalUID e diferente de events.id; apenas candidata sem autocorrecoes", () => {
  const r = conciliarEventosGoogle({
    outbox: [{ agendamento_id: "ag01", event_id: "legacy@google.com" }],
    eventos: [ev("evento1", { iCalUID: "legacy@google.com" })],
  });
  assert.equal(r.registros[0].situacao, "candidato_legado");
  assert.deepEqual(r.registros[0].candidatos[0].evidencias, ["icaluid_exato"]);
  assert.equal(r.registros[0].candidatos[0].googleEventId, "evento1");
});

test("marcador privado da VPS gera candidato de confianca elevada, nunca link", () => {
  const r = conciliarEventosGoogle({
    eventos: [vps("evento1", "ag01")],
  });
  assert.equal(r.registros[0].situacao, "candidato_marcador_vps");
  assert.equal(r.gerouVinculos, false);
});

test("evento reclamado por dois agendamentos bloqueia ambos", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", calendarEventId: "evento1" },
      { id: "ag02", calendarEventId: "evento1" }],
    eventos: [ev("evento1")],
  });
  assert.deepEqual(r.registros.map(x=>x.situacao),
    ["conflito_multiplos_agendamentos","conflito_multiplos_agendamentos"]);
});

test("marcador VPS divergente domina qualquer referencia historica", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", calendarEventId: "evento1" }],
    eventos: [vps("evento1", "ag02")],
  });
  assert.equal(r.registros.find(x=>x.agendamentoId === "ag01").situacao, "conflito_marcador");
  assert.equal(r.registros.find(x=>x.agendamentoId === "ag02").situacao, "conflito_multiplos_agendamentos");
});

test("vinculo existente valido mantido, sem criar alteracoes", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01" }],
    eventos: [ev("evento1")],
    vinculos: [link("ag01", "evento1")],
  });
  assert.equal(r.registros[0].situacao, "vinculo_confirmado");
});

test("vinculo confirmado cujo evento sumiu e sinalizado, sem recriar", () => {
  const r = conciliarEventosGoogle({
    vinculos: [link("ag01", "evento1")],
  });
  assert.equal(r.registros[0].situacao, "vinculo_ausente");
  assert.deepEqual(r.registros[0].candidatos, []);
});

test("vinculo existente e referencia historica divergente exigem revisao", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", calendarEventId: "evento2" }],
    eventos: [ev("evento1"), ev("evento2")],
    vinculos: [link("ag01", "evento1")],
  });
  assert.equal(r.registros[0].situacao, "conflito_vinculo");
});

test("duas ocorrencias de mesmo iCalUID sao ambiguas, sem escolher uma", () => {
  const r = conciliarEventosGoogle({
    outbox: [{ agendamento_id: "ag01", event_id: "serie@google.com" }],
    eventos: [ev("evento1", { iCalUID: "serie@google.com" }),
      ev("evento2", { iCalUID: "serie@google.com" })],
  });
  assert.equal(r.registros[0].situacao, "ambiguo");
  assert.equal(r.registros[0].candidatos.length, 2);
});

test("recorrencia unica ainda requer revisao manual", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", calendarEventId: "evento1" }],
    eventos: [ev("evento1", { recurringEventId: "serie1" })],
  });
  assert.equal(r.registros[0].situacao, "revisao_recorrencia");
});

test("mesmo nome ou horario NUNCA serve como evidencia", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", nomeCliente: "Segredo", data: "2026-12-01", horario: "09:00" }],
    eventos: [ev("evento1", { summary: "Segredo", start: { dateTime: "2026-12-01T09:00:00-03:00" } })],
  });
  assert.equal(r.registros[0].situacao, "sem_correspondencia");
  assert.equal(r.resumo.eventosSemReferencia, 1);
  assert.ok(!JSON.stringify(r).includes("Segredo"));
  assert.ok(!JSON.stringify(r).includes("2026-12-01"));
});

test("eventos sem referencia nao sao automaticamente agendamentos", () => {
  const r = conciliarEventosGoogle({ eventos: [ev("evento1")] });
  assert.equal(r.resumo.eventosSemReferencia, 1);
  assert.equal(r.registros.length, 0);
});

test("IDs repetidos remotos ou vinculos duplicados falham fechado", () => {
  assert.throws(() => conciliarEventosGoogle({ eventos: [ev("evento1"), ev("evento1")] }),
    { codigo: "GOOGLE_ID_REPETIDO" });
  assert.throws(() => conciliarEventosGoogle({
    vinculos: [link("ag01", "evento1"), link("ag01", "evento2")],
  }), { codigo: "VINCULO_DUPLICADO_AGENDAMENTO" });
  assert.throws(() => conciliarEventosGoogle({
    vinculos: [link("ag01", "evento1"), link("ag02", "evento1")],
  }), { codigo: "VINCULO_DUPLICADO_EVENTO" });
});

test("limites e IDs invalidos falham fechado", () => {
  assert.throws(() => conciliarEventosGoogle({ eventos: Array(1501).fill(ev("evento1")) }),
    { codigo: "LIMITE_GOOGLE" });
  assert.throws(() => conciliarEventosGoogle({ agendamentos: [{ id: "agenda/invalida" }] }),
    { codigo: "ID_AGENDAMENTO_INVALIDO" });
  assert.throws(() => conciliarEventosGoogle({ eventos: [{ id: "legacy@google.com" }] }),
    { codigo: "ID_EVENTO_INVALIDO" });
});

test("evento cancelado nao pode se tornar vinculo ativo novo", () => {
  const r = conciliarEventosGoogle({
    agendamentos: [{ id: "ag01", calendarEventId: "evento1" }],
    eventos: [ev("evento1", { status: "cancelled" })],
  });
  assert.equal(r.registros[0].situacao, "sem_correspondencia");
});
