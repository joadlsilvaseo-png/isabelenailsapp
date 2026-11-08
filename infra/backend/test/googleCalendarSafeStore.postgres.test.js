import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { gerarIdEventoGoogle } from "../src/googleCalendarEvents.js";
import {
  fingerprintIntencaoCalendar, registrarIntencaoCalendar,
  confirmarIntencaoCalendar, suspenderIntencaoIncerta,
} from "../src/googleCalendarSafeStore.js";

const { Pool } = pg;
const FLAGS = { GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED: "true" };
const OPCOES = { env: FLAGS };
const CALENDAR = "teste@example.com";
const ID = "calfase3-a";
const EVENTO = gerarIdEventoGoogle(ID);
const PEDIDO = { inicio: "2026-12-02T09:00:00-03:00",
  fim: "2026-12-02T10:00:00-03:00", servico: "teste" };
const BASE = { chaveIdempotencia: "calendario-intent-teste-a01",
  agendamentoId: ID, calendarId: CALENDAR, tipo: "criar", pedido: PEDIDO };
const GOOGLE_OK = { id: EVENTO, status: "confirmed",
  extendedProperties: { private: {
    isabeleAgendamentoId: ID, isabeleOrigem: "isabele-vps",
  } } };

test("fingerprint ordena chaves e nao salva dados no banco", () => {
  assert.equal(fingerprintIntencaoCalendar({ a: 1, b: { c: 3, d: 4 } }),
    fingerprintIntencaoCalendar({ b: { d: 4, c: 3 }, a: 1 }));
  assert.notEqual(fingerprintIntencaoCalendar({ a: 1 }),
    fingerprintIntencaoCalendar({ a: 2 }));
  assert.throws(() => fingerprintIntencaoCalendar({ a: undefined }), {
    codigo: "PEDIDO_INVALIDO",
  });
});

test("sem flag nao abre conexao e nao grava registros", async () => {
  let iniciou = 0;
  const pool = { connect() { iniciou++; throw new Error("nao usar"); } };
  await assert.rejects(registrarIntencaoCalendar(pool, BASE, { env: {} }),
    { codigo: "FILA_DESATIVADA" });
  await assert.rejects(confirmarIntencaoCalendar(pool, {
    operationId: "00000000-0000-4000-8000-000000000001", googleEvent: GOOGLE_OK,
  }, { env: {} }), { codigo: "FILA_DESATIVADA" });
  await assert.rejects(suspenderIntencaoIncerta(pool, {
    operationId: "00000000-0000-4000-8000-000000000001",
  }, { env: {} }), { codigo: "FILA_DESATIVADA" });
  assert.equal(iniciou, 0);
});

test("PostgreSQL 17: idempotencia, timeout, vinculo atomico e legado bloqueado", async () => {
  const pool = new Pool({ max: 3 });
  try {
    // O banco de CI e descartavel. Todos os registros sao ficticios.
    const first = await registrarIntencaoCalendar(pool, BASE, OPCOES);
    assert.equal(first.jaRegistrada, false);
    assert.equal(first.estado, "pendente");
    const second = await registrarIntencaoCalendar(pool, BASE, OPCOES);
    assert.deepEqual(second, { ...first, jaRegistrada: true });

    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, pedido: { ...PEDIDO, servico: "diferente" },
    }, OPCOES), { codigo: "CHAVE_IDEMPOTENCIA_DIVERGENTE" });

    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, chaveIdempotencia: "calendario-intent-teste-a02",
    }, OPCOES), { codigo: "OUTRA_OPERACAO_PENDENTE" });

    const pending = await pool.query(
      "SELECT google_event_id, fingerprint_pedido, estado FROM public.google_calendar_sync_operations WHERE operation_id = $1",
      [first.operationId],
    );
    assert.equal(pending.rows[0].google_event_id, EVENTO);
    assert.match(pending.rows[0].fingerprint_pedido, /^[a-f0-9]{64}$/);
    assert.equal(pending.rows[0].estado, "pendente");

    // Simulacao do futuro worker: apenas altera a tabela temporaria de CI.
    await pool.query(
      "UPDATE public.google_calendar_sync_operations SET estado = 'processando' WHERE operation_id = $1",
      [first.operationId],
    );
    const suspensa = await suspenderIntencaoIncerta(pool, {
      operationId: first.operationId,
    }, OPCOES);
    assert.equal(suspensa.estado, "aguardando_confirmacao");
    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, chaveIdempotencia: "calendario-intent-teste-a03",
    }, OPCOES), { codigo: "OUTRA_OPERACAO_PENDENTE" });

    await assert.rejects(confirmarIntencaoCalendar(pool, {
      operationId: first.operationId,
      googleEvent: { ...GOOGLE_OK, id: gerarIdEventoGoogle("diferente") },
    }, OPCOES), { codigo: "EVENTO_NAO_CONFIRMADO" });

    // O erro anterior reverte a transacao: nenhuma vinculacao criada.
    const before = await pool.query(
      "SELECT COUNT(*)::int AS n FROM public.google_calendar_event_links WHERE agendamento_id=$1", [ID],
    );
    assert.equal(before.rows[0].n, 0);
    const confirmada = await confirmarIntencaoCalendar(pool, {
      operationId: first.operationId, googleEvent: GOOGLE_OK,
    }, OPCOES);
    assert.equal(confirmada.jaConcluida, false);
    assert.equal((await confirmarIntencaoCalendar(pool, {
      operationId: first.operationId, googleEvent: GOOGLE_OK,
    }, OPCOES)).jaConcluida, true);

    const link = await pool.query(
      "SELECT google_event_id, origem, situacao FROM public.google_calendar_event_links WHERE agendamento_id=$1",
      [ID],
    );
    assert.deepEqual(link.rows[0], {
      google_event_id: EVENTO, origem: "vps", situacao: "ativo",
    });
    const finished = await pool.query(
      "SELECT estado, concluido_em IS NOT NULL AS confirmado FROM public.google_calendar_sync_operations WHERE operation_id=$1",
      [first.operationId],
    );
    assert.deepEqual(finished.rows[0], { estado: "concluida", confirmado: true });

    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, chaveIdempotencia: "calendario-intent-teste-a04",
    }, OPCOES), { codigo: "AGENDAMENTO_JA_VINCULADO" });

    const alterar = await registrarIntencaoCalendar(pool, {
      ...BASE, chaveIdempotencia: "calendario-intent-teste-a05",
      tipo: "reagendar", googleEventId: EVENTO,
      pedido: { inicio: "2026-12-02T12:00:00-03:00" },
    }, OPCOES);
    assert.equal(alterar.estado, "pendente");
    await pool.query(
      "UPDATE public.google_calendar_sync_operations SET estado = 'processando' WHERE operation_id=$1",
      [alterar.operationId],
    );
    await assert.rejects(confirmarIntencaoCalendar(pool, {
      operationId: alterar.operationId,
      googleEvent: { id: EVENTO, status: "confirmed" }, // Sem marcador
    }, OPCOES), { codigo: "MARCADOR_GOOGLE_DIVERGENTE" });
    assert.equal((await confirmarIntencaoCalendar(pool, {
      operationId: alterar.operationId, googleEvent: GOOGLE_OK,
    }, OPCOES)).jaConcluida, false);

    const cancelar = await registrarIntencaoCalendar(pool, {
      ...BASE, chaveIdempotencia: "calendario-intent-teste-a06",
      tipo: "cancelar", googleEventId: EVENTO, pedido: { acao: "cancelar" },
    }, OPCOES);
    await pool.query(
      "UPDATE public.google_calendar_sync_operations SET estado = 'processando' WHERE operation_id=$1",
      [cancelar.operationId],
    );
    await assert.rejects(confirmarIntencaoCalendar(pool, {
      operationId: cancelar.operationId, googleEvent: GOOGLE_OK,
    }, OPCOES), { codigo: "CANCELAMENTO_NAO_CONFIRMADO" });
    await confirmarIntencaoCalendar(pool, {
      operationId: cancelar.operationId,
      googleEvent: { id: EVENTO, status: "cancelled" },
    }, OPCOES);
    const after = await pool.query(
      "SELECT situacao FROM public.google_calendar_event_links WHERE agendamento_id=$1", [ID],
    );
    assert.equal(after.rows[0].situacao, "cancelado");
    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, tipo: "reagendar", googleEventId: EVENTO,
      chaveIdempotencia: "calendario-intent-teste-a07",
    }, OPCOES), { codigo: "EVENTO_SEM_VINCULO_CONFIRMADO" });

    // Candidato legado bloqueia criacao automatica do mesmo ID.
    await pool.query(
      `INSERT INTO public.google_calendar_reconciliation_candidates
       (agendamento_id, calendar_id, google_event_id, fonte)
       VALUES ('legacy-01',$1,'evento-legado-01','google_calendar')`,
      [CALENDAR],
    );
    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, agendamentoId: "legacy-01",
      chaveIdempotencia: "calendario-intent-teste-legacy",
    }, OPCOES), { codigo: "LEGADO_AGUARDANDO_RECONCILIACAO" });

    // Vinculo legado validado so pode ser lido/auditado; nunca PATCH via
    // adaptador direto que exige propriedade privada da VPS.
    await pool.query(
      `INSERT INTO public.google_calendar_event_links
       (agendamento_id, calendar_id, google_event_id, origem,
        metodo_verificacao, verificado_em, verificado_por)
       VALUES ('legacy-02',$1,'evento-legado-02','legado_validado',
               'revisao_manual_confirmada',NOW(),'administradora')`, [CALENDAR],
    );
    await assert.rejects(registrarIntencaoCalendar(pool, {
      ...BASE, agendamentoId: "legacy-02", tipo: "alterar_servico",
      googleEventId: "evento-legado-02", chaveIdempotencia: "calendario-intent-legacy-02",
    }, OPCOES), { codigo: "EVENTO_LEGADO_NAO_MIGRADO" });
  } finally {
    await pool.end();
  }
});
