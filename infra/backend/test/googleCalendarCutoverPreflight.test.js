import test from "node:test";
import assert from "node:assert/strict";
import { coletarPreflightCalendar } from "../scripts/calendarCutoverPreflight.mjs";

function mock({ tables = [], lease = false, porTabela = {} } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push(sql);
      assert.match(sql.trim(), /^SELECT/);
      if (sql.includes("FROM pg_class")) {
        assert.ok(Array.isArray(params[0]));
        return { rows: tables.map(tabela => ({ tabela })) };
      }
      if (sql.includes("information_schema.columns")) {
        return { rows: lease ? [{ ok: 1 }] : [] };
      }
      const nome = [...sql.matchAll(/FROM public\.([a-z_]+)/g)][0]?.[1];
      assert.ok(nome, "SQL para tabela nao reconhecida");
      return { rows: Object.entries(porTabela[nome] || {}).map(([situacao, total]) =>
        ({ situacao, total })) };
    },
  };
}

test("preflight sem migrations nao presume ambiente pronto, somente SELECT", async () => {
  const db = mock();
  const r = await coletarPreflightCalendar(db);
  assert.equal(r.somenteLeitura, true);
  assert.equal(r.autorizadoParaMigrar, false);
  assert.ok(r.bloqueios.includes("MIGRACAO_024_AUSENTE"));
  assert.ok(r.bloqueios.includes("MIGRACAO_025_AUSENTE"));
  assert.ok(db.chamadas.every(q => q.trim().startsWith("SELECT")));
});

test("preflight apresenta somente contagens, nunca nomes ou IDs individuais", async () => {
  const db = mock({
    tables: [
      "google_calendar_oauth_credentials",
      "google_calendar_event_links", "google_calendar_sync_operations",
      "google_calendar_reconciliation_candidates", "pix_calendar_outbox",
      "agendamento_cancelamentos", "pix_reagendamentos_pagos",
      "agendamento_alteracoes_servico",
    ], lease: true,
    porTabela: {
      pix_calendar_outbox: { pendente: 2, enviado: 10 },
      google_calendar_sync_operations: { aguardando_confirmacao: 1 },
      google_calendar_reconciliation_candidates: { conflito: 3 },
    },
  });
  const r = await coletarPreflightCalendar(db);
  assert.equal(r.totaisPorSituacao.pix_calendar_outbox.pendente, 2);
  assert.equal(r.totaisPorSituacao.google_calendar_sync_operations.aguardando_confirmacao, 1);
  assert.ok(r.bloqueios.includes("OUTBOX_LEGADA_COM_OPERACOES"));
  assert.ok(r.bloqueios.includes("SINCRONIZACAO_GOOGLE_INDEFINIDA"));
  assert.ok(r.bloqueios.includes("CANDIDATOS_A_REVISAR"));
  assert.equal(r.autorizadoParaMigrar, false);
  assert.equal(r.requerRevisaoHumana, true);
  assert.ok(db.chamadas.every(q => !/nome_cliente|telefone|refresh_token_encrypted/i.test(q)));
});

test("zero bloqueios SQL NAO significa autorizacao de cutover", async () => {
  const db = mock({
    tables: [
      "google_calendar_oauth_credentials", "google_calendar_event_links",
      "google_calendar_sync_operations", "google_calendar_reconciliation_candidates",
      "pix_calendar_outbox",
    ], lease: true,
  });
  const r = await coletarPreflightCalendar(db);
  assert.deepEqual(r.bloqueios, []);
  assert.equal(r.autorizadoParaMigrar, false);
});
