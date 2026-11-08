/**
 * PostgreSQL 17 real: executado SOMENTE no GitHub Actions, banco efemero
 * "isabele_ci". Nunca roda automaticamente pelo npm test.
 * Nenhuma rede Google/Firebase, sem dados pessoais.
 */
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { criarRepositorioCalendarCutover } from "../src/googleCalendarCutoverStore.js";
import { gerarIdEventoGoogle, criarAdaptadorGoogleCalendar } from "../src/googleCalendarEvents.js";

const ENVS = {
  GOOGLE_CALENDAR_OAUTH_ENABLED: "true",
  GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_CRIAR_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_REAGENDAR_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_CANCELAR_ENABLED: "true",
  GOOGLE_CALENDAR_CUTOVER_ALTERAR_SERVICO_ENABLED: "true",
};
const CAL = "calendar-ci@example.com";
const hash = c => c.repeat(64);
const request = (agendamentoId, caractere = "a") => ({
  operationId: randomUUID(), chaveIdempotencia: "cutover-" + randomUUID(),
  agendamentoId, tipo: "criar", fingerprintPedido: hash(caractere),
  estadoConciliacao: "sem_evento_confirmado", agendamentoNovoAposCorte: true,
});
const Codigo = (codigo) => ({ codigo });

test("cutover PG17: idempotencia, lease, vinculo atomico, timeout e bloqueio de legado", async () => {
  assert.equal(process.env.GOOGLE_CALENDAR_CUTOVER_PG_TEST, "ci");
  assert.equal(process.env.PGDATABASE, "isabele_ci");
  const pool = new pg.Pool();
  try {
    // Schema sintetico MINIMO para preflight da antiga outbox.
    await pool.query(`CREATE TABLE IF NOT EXISTS public.pix_calendar_outbox
      (agendamento_id TEXT PRIMARY KEY)`);

    const cutover = criarRepositorioCalendarCutover(pool, { env: ENVS, calendarId: CAL });
    const r1 = request("agendamento-cutover-a");
    const p1 = await cutover.prepararIntencao(r1);
    assert.deepEqual(p1, { operationId: r1.operationId, estado: "pendente", reutilizada: false });
    assert.deepEqual(await cutover.prepararIntencao(r1), {
      operationId: r1.operationId, estado: "pendente", reutilizada: true,
    });
    await assert.rejects(cutover.prepararIntencao({ ...r1, fingerprintPedido: hash("b") }),
      Codigo("IDEMPOTENCIA_DIVERGENTE"));

    await assert.rejects(cutover.prepararIntencao(request(r1.agendamentoId, "c")),
      Codigo("OPERACAO_CONCORRENTE_OU_VINCULO_DUPLICADO"));

    const claim1 = await cutover.reivindicarProxima();
    assert.equal(claim1.operation_id, r1.operationId);
    assert.equal(claim1.google_event_id, gerarIdEventoGoogle(r1.agendamentoId));
    assert.equal(claim1.estado, "processando");
    assert.ok(claim1.lease_token);
    await assert.rejects(cutover.registrarResultadoIncerto({
      operationId: r1.operationId, leaseToken: randomUUID(), codigoErro: "TIMEOUT",
    }), Codigo("LEASE_PERDIDO"));

    assert.deepEqual(await cutover.registrarResultadoIncerto({
      operationId: r1.operationId, leaseToken: claim1.lease_token, codigoErro: "TIMEOUT",
    }), { operationId: r1.operationId, estado: "aguardando_confirmacao" });
    assert.equal(await cutover.reivindicarProxima(), null);
    await assert.rejects(cutover.prepararIntencao(request(r1.agendamentoId, "d")),
      Codigo("OPERACAO_CONCORRENTE_OU_VINCULO_DUPLICADO"));

    // Outro agendamento isolado: Google ficticio confirmou retorno ja validado.
    const r2 = request("agendamento-cutover-b");
    await cutover.prepararIntencao(r2);
    const claim2 = await cutover.reivindicarProxima();
    assert.equal(claim2.operation_id, r2.operationId);
    const ev = {
      id: gerarIdEventoGoogle(r2.agendamentoId), status: "confirmed",
      extendedProperties: {
        private: { isabeleOrigem: "isabele-vps", isabeleAgendamentoId: r2.agendamentoId },
      },
    };
    await assert.rejects(cutover.confirmarCriacao({
      operationId: r2.operationId, leaseToken: claim2.lease_token,
      evento: { ...ev, extendedProperties: { private: { isabeleOrigem: "outro" } } },
    }), Codigo("EVENTO_GOOGLE_NAO_VERIFICADO"));
    assert.equal((await pool.query(
      "SELECT COUNT(*)::int AS n FROM public.google_calendar_event_links",
    )).rows[0].n, 0);

    const confirmado = await cutover.confirmarCriacao({
      operationId: r2.operationId, leaseToken: claim2.lease_token, evento: ev,
    });
    assert.deepEqual(confirmado, {
      operationId: r2.operationId, googleEventId: ev.id, concluida: true,
    });
    const link = (await pool.query(
      "SELECT * FROM public.google_calendar_event_links WHERE agendamento_id = $1",
      [r2.agendamentoId],
    )).rows[0];
    assert.equal(link.google_event_id, ev.id);
    assert.equal(link.origem, "vps");
    assert.equal(link.metodo_verificacao, "google_api");
    assert.equal(link.situacao, "ativo");
    const finalizada = (await pool.query(
      "SELECT estado, lease_token, concluido_em FROM public.google_calendar_sync_operations WHERE operation_id = $1",
      [r2.operationId],
    )).rows[0];
    assert.equal(finalizada.estado, "concluida");
    assert.equal(finalizada.lease_token, null);
    assert.ok(finalizada.concluido_em);
    await assert.rejects(cutover.confirmarCriacao({
      operationId: r2.operationId, leaseToken: claim2.lease_token, evento: ev,
    }), Codigo("LEASE_PERDIDO"));
    assert.deepEqual(await cutover.prepararIntencao(r2), {
      operationId: r2.operationId, estado: "concluida", reutilizada: true,
    });

    // Antiga outbox existente: nao duplicar evento mesmo se flag ligada.
    await pool.query(
      "INSERT INTO public.pix_calendar_outbox (agendamento_id) VALUES ($1)",
      ["agendamento-cutover-legado"],
    );
    await assert.rejects(cutover.prepararIntencao(request("agendamento-cutover-legado")),
      Codigo("CRIACAO_SEM_EVIDENCIA"));

    // Se o worker cair com o lease expirado, entrada NAO volta para pending.
    const r3 = request("agendamento-cutover-c");
    await cutover.prepararIntencao(r3);
    const claim3 = await cutover.reivindicarProxima();
    assert.equal(claim3.operation_id, r3.operationId);
    await pool.query(
      "UPDATE public.google_calendar_sync_operations SET bloqueado_ate = NOW() - INTERVAL '10 seconds' WHERE operation_id = $1",
      [r3.operationId],
    );
    assert.equal(await cutover.bloquearLeasesExpirados(), 1);
    assert.equal(await cutover.reivindicarProxima(), null);
    await assert.rejects(cutover.confirmarCriacao({
      operationId: r3.operationId, leaseToken: claim3.lease_token,
      evento: {
        id: gerarIdEventoGoogle(r3.agendamentoId), status: "confirmed",
        extendedProperties: { private: {
          isabeleOrigem: "isabele-vps", isabeleAgendamentoId: r3.agendamentoId,
        } },
      },
    }), Codigo("LEASE_PERDIDO"));
    const incerta = (await pool.query(
      "SELECT estado, lease_token, ultimo_codigo_erro FROM public.google_calendar_sync_operations WHERE operation_id=$1",
      [r3.operationId],
    )).rows[0];
    assert.deepEqual(incerta, {
      estado: "aguardando_confirmacao", lease_token: null, ultimo_codigo_erro: "LEASE_EXPIRADO",
    });

    // Jornada ponta a ponta SEM rede real: insert na API Google MOCK,
    // leitura do evento ficticio e confirmacao atomica no PostgreSQL 17.
    const r4 = request("agendamento-cutover-d");
    await cutover.prepararIntencao(r4);
    const claim4 = await cutover.reivindicarProxima();
    assert.equal(claim4.operation_id, r4.operationId);
    const googleMock = new Map();
    const httpMock = [];
    const adaptador = criarAdaptadorGoogleCalendar({
      calendarId: CAL, env: ENVS,
      obterAccessToken: async () => "access-token-ficticio",
      fetcher: async (url, options) => {
        const endpoint = new URL(url);
        assert.equal(endpoint.origin, "https://www.googleapis.com");
        const metodo = options.method;
        httpMock.push(metodo);
        if (metodo === "POST") {
          const payload = JSON.parse(options.body);
          assert.equal(payload.id, gerarIdEventoGoogle(r4.agendamentoId));
          assert.equal(payload.extendedProperties.private.isabeleAgendamentoId, r4.agendamentoId);
          const documento = { ...payload, etag: '"etag-mock-v1"', status: "confirmed" };
          googleMock.set(payload.id, documento);
          return { status: 201, ok: true, json: async () => documento };
        }
        if (metodo === "GET") {
          const id = decodeURIComponent(endpoint.pathname.split("/").at(-1));
          const doc = googleMock.get(id);
          return { status: doc ? 200 : 404, ok: Boolean(doc), json: async () => doc };
        }
        throw new Error("Nao deve atualizar ou cancelar na jornada de criacao.");
      },
    });
    const resultadoGoogle = await adaptador.criarEvento({
      agendamentoId: r4.agendamentoId,
      nomeCliente: "Cliente Ficticia",
      servico: "Manicure",
      inicio: "2026-12-01T09:00:00-03:00",
      fim: "2026-12-01T10:00:00-03:00",
    });
    assert.equal(resultadoGoogle.criado, true);
    const retornoVerificado = await adaptador.consultarEvento({
      eventId: resultadoGoogle.eventId,
    });
    const persistido = await cutover.confirmarCriacao({
      operationId: r4.operationId,
      leaseToken: claim4.lease_token,
      evento: retornoVerificado,
    });
    assert.equal(persistido.googleEventId, resultadoGoogle.eventId);
    assert.deepEqual(httpMock, ["POST", "GET"]);
    const verificacao = await pool.query(
      "SELECT estado FROM public.google_calendar_sync_operations WHERE operation_id = $1",
      [r4.operationId],
    );
    assert.equal(verificacao.rows[0].estado, "concluida");

    // Flags desligadas: nao altera estado algum, nem tenta reivindicar.
    const paused = criarRepositorioCalendarCutover(pool, { env: {}, calendarId: CAL });
    assert.equal(await paused.reivindicarProxima(), null);
    await assert.rejects(paused.prepararIntencao(request("agendamento-cutover-pausado")),
      Codigo("CORTE_NAO_AUTORIZADO"));
  } finally {
    await pool.end();
  }
});
