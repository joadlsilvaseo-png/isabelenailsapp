import test from "node:test";
import assert from "node:assert/strict";

import {
  processarCancelamentoAgendamento,
  processarProximoCancelamentoAgendamento,
  solicitarCancelamentoAgendamento
} from "../src/agendamentoCancelamentos.js";
import { deveEfetivarAgendamentoAposCredito } from "../src/pixConsultaPagamento.js";
import { efetivarAgendamentoPix } from "../src/pixEfetivacao.js";
import { identificarNotificacoesAgendamento } from "../src/agendaNotificacoes.js";
import {
  montarPayloadCancelamentoCalendar,
  enviarCancelamentoCalendar,
  processarProximoCancelamentoCalendar
} from "../src/pixCalendarWorker.js";

const AGENDAMENTO_ID = "pix_ab12cd34";
const COBRANCA_ID = "11111111-2222-4333-8444-555555555555";
const UID_CLIENTE = "cliente-123";
const UID_ADMIN = "admin-123";

function fixture({ tipo = "cliente", falharSql = null, falharFirestore = false, semPix = false } = {}) {
  const dados = {
    status: "confirmado",
    clienteId: UID_CLIENTE,
    pixCobrancaId: COBRANCA_ID,
    calendarEventId: `evt_${AGENDAMENTO_ID}`,
    nomeCliente: "Cliente Teste"
  };
  const docs = new Map([
    [`agendamentos:${AGENDAMENTO_ID}`, structuredClone(dados)],
    [`usuarios:${UID_ADMIN}`, { role: "admin", ativo: true }]
  ]);
  if (semPix) {
    delete dados.pixCobrancaId;
    docs.set(`agendamentos:${AGENDAMENTO_ID}`, structuredClone(dados));
  }
  const state = {
    charge: semPix ? null : { id: COBRANCA_ID, estado: "paga", agendamento_id: AGENDAMENTO_ID },
    reservation: { id: "reserva-1", cobranca_id: semPix ? null : COBRANCA_ID, estado: "confirmada", agendamento_id: AGENDAMENTO_ID, inicio_minuto: 600, fim_minuto: 660 },
    cancellation: null,
    calendarAttempts: 0,
    failAt: falharSql,
    docs,
    lock: Promise.resolve()
  };

  const pool = {
    state,
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("insert into public.agendamento_cancelamentos")) {
        if (!state.cancellation) {
          state.cancellation = {
            agendamento_id: params[0], cobranca_id: params[1], cliente_uid: params[2],
            solicitante_uid: params[3], tipo: params[4], calendar_event_id: params[5],
            calendar_estado: params[6], estado: "solicitada", tentativas: 0,
            calendar_tentativas: 0
          };
        }
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith("select * from public.agendamento_cancelamentos")) {
        return { rows: state.cancellation ? [structuredClone(state.cancellation)] : [] };
      }
      if (normalized.startsWith("update public.agendamento_cancelamentos") && normalized.includes("proxima_tentativa_em = now() + interval '15 seconds'")) {
        if (state.cancellation) state.cancellation.tentativas += 1;
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith("with proxima as (") && normalized.includes("agendamento_cancelamentos")) {
        if (!state.cancellation || state.cancellation.estado !== "solicitada" || state.cancellation.bloqueado_ate) return { rows: [] };
        state.cancellation.tentativas += 1;
        state.cancellation.bloqueado_ate = "lease";
        return { rows: [{ agendamento_id: AGENDAMENTO_ID, tentativas: state.cancellation.tentativas }] };
      }
      if (normalized.startsWith("update public.agendamento_cancelamentos") && normalized.includes("estado = case when $2::boolean")) {
        if (state.cancellation) {
          state.cancellation.estado = params[1] ? "falha_permanente" : "solicitada";
          state.cancellation.bloqueado_ate = null;
          state.cancellation.ultimo_erro = params[3];
        }
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith("update public.agendamento_cancelamentos") && normalized.includes("calendar_estado")) {
        state.calendarAttempts += 1;
        if (state.cancellation) state.cancellation.calendar_estado = "enviado";
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`SQL global inesperado no teste: ${normalized.slice(0, 100)}`);
    },
    async connect() {
      let liberar;
      let snapshot;
      const anterior = state.lock;
      state.lock = new Promise((resolve) => { liberar = resolve; });
      await anterior;
      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (normalized === "begin") {
            snapshot = {
              reservation: structuredClone(state.reservation),
              cancellation: structuredClone(state.cancellation)
            };
            return { rows: [] };
          }
          if (normalized === "commit") return { rows: [] };
          if (normalized === "rollback") {
            state.reservation = snapshot.reservation;
            state.cancellation = snapshot.cancellation;
            return { rows: [] };
          }
          if (normalized.includes("from public.agendamento_cancelamentos") && normalized.endsWith("for update")) {
            return { rows: state.cancellation ? [structuredClone(state.cancellation)] : [] };
          }
          if (normalized.startsWith("select c.id, c.estado as cobranca_estado")) {
            if (!state.charge || !state.reservation) return { rows: [] };
            return { rows: [{
              id: state.charge.id,
              cobranca_estado: state.charge.estado,
              reserva_id: state.reservation.id,
              reserva_estado: state.reservation.estado,
              reserva_agendamento_id: state.reservation.agendamento_id,
              cobranca_agendamento_id: state.charge.agendamento_id
            }] };
          }
          if (normalized.startsWith("update public.pix_reservas")) {
            if (normalized.includes("cobranca_id is null") && state.reservation.cobranca_id !== null) {
              return { rowCount: 0, rows: [] };
            }
            if (state.failAt === "reservation") {
              state.failAt = null;
              throw new Error("PostgreSQL unavailable during reservation release");
            }
            state.reservation.estado = "cancelada";
            return { rowCount: 1, rows: [{ id: state.reservation.id }] };
          }
          if (normalized.startsWith("update public.agendamento_cancelamentos") && normalized.includes("set estado = 'concluida'")) {
            if (state.failAt === "commit_record") {
              state.failAt = null;
              throw new Error("PostgreSQL unavailable after Firestore update");
            }
            state.cancellation.estado = "concluida";
            state.cancellation.bloqueado_ate = null;
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`SQL de conexão inesperado no teste: ${normalized.slice(0, 120)}`);
        },
        release() { liberar(); }
      };
    }
  };

  const firestore = {
    collection(collection) {
      return { doc(id) { return { collection, id }; } };
    },
    async runTransaction(callback) {
      const tx = {
        async get(ref) {
          const found = state.docs.get(`${ref.collection}:${ref.id}`);
          return { exists: Boolean(found), data: () => structuredClone(found) };
        },
        update(ref, values) {
          if (falharFirestore) throw new Error("Firestore unavailable");
          const found = state.docs.get(`${ref.collection}:${ref.id}`);
          state.docs.set(`${ref.collection}:${ref.id}`, { ...found, ...values });
        }
      };
      return callback(tx);
    }
  };

  return {
    pool,
    firestore,
    state,
    dependencies: { firestore, FieldValue: { serverTimestamp: () => "SERVER_TIMESTAMP" } },
    action: tipo === "cliente" ? "cancelar_cliente" : "cancelar_admin",
    uid: tipo === "cliente" ? UID_CLIENTE : UID_ADMIN
  };
}

test("cancelamento da cliente com PIX pago preserva a cobrança e libera a reserva", async () => {
  const f = fixture();
  const result = await solicitarCancelamentoAgendamento({
    pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies
  });
  assert.equal(result.concluido, true);
  assert.equal(result.pixPago, true);
  assert.equal(f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).status, "cancelado_cliente");
  assert.equal(f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).canceladoPor, UID_CLIENTE);
  assert.equal(f.state.reservation.estado, "cancelada");
  assert.equal(f.state.charge.estado, "paga");
  assert.equal(f.state.cancellation.estado, "concluida");
});

test("cancelamento administrativo com PIX pago registra profissional e preserva financeiro", async () => {
  const f = fixture({ tipo: "profissional" });
  const result = await solicitarCancelamentoAgendamento({
    pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies
  });
  assert.equal(result.pixPago, true);
  const agendamento = f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`);
  assert.equal(agendamento.status, "cancelado_profissional");
  assert.equal(agendamento.canceladoPor, UID_ADMIN);
  assert.equal(agendamento.canceladoPorTipo, "profissional");
  assert.equal(f.state.charge.estado, "paga");
  assert.equal(f.state.reservation.estado, "cancelada");
});

test("reserva cancelada deixa de ocupar o intervalo e aceita uma nova reserva", async () => {
  const f = fixture();
  await solicitarCancelamentoAgendamento({
    pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies
  });
  const intervaloAtivo = f.state.reservation.estado === "reservada" || f.state.reservation.estado === "confirmada";
  assert.equal(intervaloAtivo, false);
  const novaReserva = { estado: "reservada", inicio_minuto: 600, fim_minuto: 660 };
  const ocupacoesAtivas = [f.state.reservation].filter((reserva) => ["reservada", "confirmada"].includes(reserva.estado));
  assert.equal(ocupacoesAtivas.some((reserva) =>
    novaReserva.inicio_minuto < reserva.fim_minuto && novaReserva.fim_minuto > reserva.inicio_minuto
  ), false);
});

test("solicitação repetida da mesma cliente é idempotente e mantém um único evento", async () => {
  const f = fixture();
  const dados = { pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies };
  await solicitarCancelamentoAgendamento(dados);
  const canceladoEm = f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).canceladoEm;
  const repetido = await solicitarCancelamentoAgendamento(dados);
  assert.equal(repetido.concluido, true);
  assert.equal(repetido.idempotente, true);
  assert.equal(f.state.cancellation.estado, "concluida");
  assert.equal(f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).canceladoEm, canceladoEm);
});

test("falha PostgreSQL depois da gravação Firestore recupera a reserva sem refazer o cancelamento", async () => {
  const f = fixture({ falharSql: "commit_record" });
  const dados = { pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies };
  const primeiro = await solicitarCancelamentoAgendamento(dados);
  assert.equal(primeiro.cancelamentoPendente, true);
  assert.equal(primeiro.firestoreCancelado, true);
  assert.equal(f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).status, "cancelado_cliente");
  assert.equal(f.state.reservation.estado, "confirmada");
  const recuperado = await processarCancelamentoAgendamento(f.pool, AGENDAMENTO_ID, f.dependencies);
  assert.equal(recuperado.concluido, true);
  assert.equal(f.state.reservation.estado, "cancelada");
  assert.equal(f.state.charge.estado, "paga");
});

test("falha Firestore mantém a solicitação durável e o worker conclui depois", async () => {
  const f = fixture();
  let deveFalhar = true;
  const dados = { pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action,
    dependencies: { ...f.dependencies, atualizarFirestore: async () => {
      if (deveFalhar) { deveFalhar = false; throw new Error("Firestore indisponível"); }
      const current = f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`);
      f.state.docs.set(`agendamentos:${AGENDAMENTO_ID}`, { ...current, status: "cancelado_cliente", canceladoPor: UID_CLIENTE });
    } }
  };
  const primeiro = await solicitarCancelamentoAgendamento(dados);
  assert.equal(primeiro.cancelamentoPendente, true);
  assert.equal(primeiro.firestoreCancelado, false);
  assert.equal(f.state.reservation.estado, "confirmada");
  const segundo = await processarProximoCancelamentoAgendamento(f.pool, dados.dependencies);
  assert.equal(segundo.concluido, true);
  assert.equal(f.state.reservation.estado, "cancelada");
});

test("duas requisições concorrentes resultam em um único cancelamento", async () => {
  const f = fixture();
  const dados = { pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies };
  const resultados = await Promise.all([
    solicitarCancelamentoAgendamento(dados),
    solicitarCancelamentoAgendamento(dados)
  ]);
  assert.equal(resultados.every((resultado) => resultado.concluido), true);
  assert.equal(f.state.cancellation.estado, "concluida");
  assert.equal(f.state.reservation.estado, "cancelada");
  assert.equal(f.state.charge.estado, "paga");
});

test("cancelamento mantém o bloqueio PostgreSQL até concluir a transição concorrente", async () => {
  const f = fixture();
  const solicitacao = await f.pool.query(`
    INSERT INTO public.agendamento_cancelamentos (
      agendamento_id, cobranca_id, cliente_uid, solicitante_uid, tipo,
      calendar_event_id, calendar_estado
    ) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING
  `, [AGENDAMENTO_ID, COBRANCA_ID, UID_CLIENTE, UID_CLIENTE, "cliente", null, "dispensado"]);
  let liberado;
  let entrouNoFirestore;
  const barreira = new Promise((resolve) => { liberado = resolve; });
  const entrada = new Promise((resolve) => { entrouNoFirestore = resolve; });
  const cancellation = processarCancelamentoAgendamento(f.pool, AGENDAMENTO_ID, {
    firestore: f.firestore,
    atualizarFirestore: async () => {
      entrouNoFirestore();
      await barreira;
    }
  });
  await entrada;
  let concorrenteLeu = false;
  const concorrente = f.pool.connect().then(async (conexao) => {
    await conexao.query("BEGIN");
    const estadoVisto = f.state.reservation.estado;
    concorrenteLeu = true;
    await conexao.query("COMMIT");
    conexao.release();
    return estadoVisto;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(concorrenteLeu, false);
  liberado();
  await cancellation;
  assert.equal(await concorrente, "cancelada");
  assert.equal(concorrenteLeu, true);
});

test("notificação de cancelamento é endereçada ao destinatário correto e só no evento de transição", () => {
  const cliente = identificarNotificacoesAgendamento(
    { status: "confirmado" }, { status: "cancelado_cliente", servico: "Manicure", clienteId: UID_CLIENTE }
  );
  const profissional = identificarNotificacoesAgendamento(
    { status: "confirmado" }, { status: "cancelado_profissional", servico: "Manicure", clienteId: UID_CLIENTE }
  );
  assert.equal(cliente[0].destinatario, "admin");
  assert.equal(cliente[0].tipo, "cancelamento_cliente");
  assert.equal(profissional[0].destinatario, "cliente");
  assert.equal(profissional[0].tipo, "cancelamento_profissional");
  assert.equal(identificarNotificacoesAgendamento({ status: "cancelado_cliente" }, { status: "cancelado_cliente" }).length, 0);
});

test("Calendar usa o mesmo ID estável e retry repete a ação CANCELAR", async () => {
  assert.deepEqual(montarPayloadCancelamentoCalendar({ calendar_event_id: "evt_abc" }), {
    acao: "CANCELAR", eventId: "evt_abc"
  });
  let payload;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes("WITH proximo AS")) return { rows: [{
            id: "1", agendamento_id: AGENDAMENTO_ID, calendar_event_id: "evt_abc",
            calendar_tentativas: 1
          }] };
          return { rows: [] };
        },
        release() {}
      };
    },
    async query() { return { rowCount: 1, rows: [] }; }
  };
  const result = await processarProximoCancelamentoCalendar(pool, async (evento) => {
    payload = montarPayloadCancelamentoCalendar(evento);
  });
  assert.equal(result.enviado, true);
  assert.deepEqual(payload, { acao: "CANCELAR", eventId: "evt_abc" });
});

test("Calendar dispensa criacao pendente e libera cancelamento na mesma transacao", async () => {
  const sqls = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          sqls.push(sql);
          if (sql.includes("WITH proximo AS")) return { rows: [{
            agendamento_id: AGENDAMENTO_ID, calendar_event_id: "evt_teste",
            calendar_tentativas: 1
          }] };
          return { rows: [] };
        },
        release() {}
      };
    },
    async query() { return { rowCount: 1, rows: [] }; }
  };
  let enviados = 0;
  const resultado = await processarProximoCancelamentoCalendar(pool, async () => { enviados++; });
  assert.equal(resultado.enviado, true);
  assert.equal(enviados, 1);
  const selecao = sqls.find(sql => sql.includes("WITH proximo AS"));
  assert.match(selecao, /criacao\.status = 'enviando'/);
  assert.match(selecao, /criacao\.bloqueado_ate > NOW\(\)/);
  assert.match(selecao, /UPDATE public\.pix_calendar_outbox AS criacao/);
  assert.match(selecao, /status = 'dispensado'/);
  assert.doesNotMatch(selecao, /criacao\.status <> 'enviado'/);
});

test("Calendar processa cancelamento sem criacao na outbox", async () => {
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes("WITH proximo AS")) return { rows: [{
            agendamento_id: AGENDAMENTO_ID,
            calendar_event_id: "evt_sem_criacao", calendar_tentativas: 1
          }] };
          return { rows: [] };
        },
        release() {}
      };
    },
    async query() { return { rowCount: 1, rows: [] }; }
  };
  const resultado = await processarProximoCancelamentoCalendar(pool, async () => {});
  assert.equal(resultado.enviado, true);
});

test("falha informada pelo Apps Script agenda nova tentativa sem request real", async () => {
  await assert.rejects(enviarCancelamentoCalendar(
    { calendar_event_id: "evt_abc" },
    async (_url, options) => {
      assert.equal(JSON.parse(options.body).eventId, "evt_abc");
      return { ok: true, status: 200, async text() { return JSON.stringify({ success: false, error: "calendar unavailable" }); } };
    }
  ), /Apps Script nao confirmou sucesso/);

  let estadoFila = "enviando";
  let requestCount = 0;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes("WITH proximo AS")) return { rows: [{
            id: "1", agendamento_id: AGENDAMENTO_ID, calendar_event_id: "evt_abc",
            calendar_tentativas: 1
          }] };
          return { rows: [] };
        },
        release() {}
      };
    },
    async query(sql) {
      if (sql.includes("calendar_estado = 'pendente'")) estadoFila = "pendente";
      requestCount += 1;
      return { rowCount: 1, rows: [] };
    }
  };
  const result = await processarProximoCancelamentoCalendar(pool, async () => {
    throw new Error("Apps Script timeout");
  });
  assert.equal(result.enviado, false);
  assert.equal(estadoFila, "pendente");
  assert.equal(requestCount, 1);
});

test("agendamento antigo sem PIX ainda pode ser cancelado pelo fluxo existente", async () => {
  const f = fixture();
  const doc = f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`);
  delete doc.pixCobrancaId;
  delete doc.calendarEventId;
  f.state.docs.set(`agendamentos:${AGENDAMENTO_ID}`, doc);
  const result = await solicitarCancelamentoAgendamento({
    pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies
  });
  assert.equal(result.concluido, true);
  assert.equal(f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).status, "cancelado_cliente");
  assert.equal(f.state.reservation.estado, "confirmada");
});

test("cancelamento de agendamento sem PIX libera a reserva persistida sem alterar cobranças", async () => {
  const f = fixture({ semPix: true });
  const result = await solicitarCancelamentoAgendamento({
    pool: f.pool, firestore: f.firestore, uid: f.uid,
    agendamentoId: AGENDAMENTO_ID, acao: f.action, dependencies: f.dependencies
  });
  assert.equal(result.concluido, true);
  assert.equal(f.state.docs.get(`agendamentos:${AGENDAMENTO_ID}`).status, "cancelado_cliente");
  assert.equal(f.state.reservation.estado, "cancelada");
  assert.equal(f.state.charge, null);
});

test("polling de cobrança paga não tenta confirmar novamente uma reserva cancelada", async () => {
  assert.equal(deveEfetivarAgendamentoAposCredito(
    { estado_reserva: "cancelada" },
    { situacao: "pago_requer_analise" }
  ), false);
  let fireStoreChamado = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (normalized === "begin" || normalized === "rollback") return { rows: [] };
          if (normalized.includes("from public.pix_cobrancas c") && normalized.includes("for update of c, r")) {
            return { rows: [{
              id: COBRANCA_ID, estado: "paga", mp_order_id: "order-1", pago_em: new Date(),
              cliente_uid: UID_CLIENTE, reserva_id: "reserva-1", reserva_cobranca_id: COBRANCA_ID,
              reserva_cliente_uid: UID_CLIENTE, reserva_servico_id: "servico-1", reserva_estado: "cancelada",
              reserva_vence_em: new Date(Date.now() + 60000), inicio_minuto: 600, fim_minuto: 660,
              reserva_data_iso: "2026-10-15"
            }] };
          }
          throw new Error(`SQL inesperado: ${normalized}`);
        },
        release() {}
      };
    }
  };
  await assert.rejects(efetivarAgendamentoPix({
    pool, cobrancaId: COBRANCA_ID, uid: UID_CLIENTE,
    dependencias: {
      confirmarFirestore: async () => { fireStoreChamado = true; }
    }
  }), /Agendamento cancelado não pode ser reativado/);
  assert.equal(fireStoreChamado, false);
});

test("cliente não cancela agendamento alheio e usuário sem perfil ativo não cancela como admin", async () => {
  const cliente = fixture();
  await assert.rejects(solicitarCancelamentoAgendamento({
    pool: cliente.pool, firestore: cliente.firestore, uid: "outro-uid",
    agendamentoId: AGENDAMENTO_ID, acao: "cancelar_cliente", dependencies: cliente.dependencies
  }), /não pertence ao usuário/);

  const admin = fixture({ tipo: "profissional" });
  admin.state.docs.set(`usuarios:${UID_ADMIN}`, { role: "admin", ativo: false });
  await assert.rejects(solicitarCancelamentoAgendamento({
    pool: admin.pool, firestore: admin.firestore, uid: UID_ADMIN,
    agendamentoId: AGENDAMENTO_ID, acao: "cancelar_admin", dependencies: admin.dependencies
  }), /Acesso administrativo negado/);
});


test("Apps Script exige confirmacao JSON de sucesso antes de registrar cancelamento", async () => {
  await assert.rejects(enviarCancelamentoCalendar(
    { calendar_event_id: "evt_abc" },
    async () => ({ ok: true, status: 200, async text() { return "CANCELADO COM SUCESSO"; } })
  ), /Apps Script nao confirmou sucesso/);

  let enviado;
  const resultado = await enviarCancelamentoCalendar(
    { agendamento_id: "isento_teste", calendar_event_id: "evt_isento_teste" },
    async (_url, opcoes) => {
      enviado = JSON.parse(opcoes.body);
      return { ok: true, status: 200, async text() { return '{"ok":true,"status":"CANCELADO"}'; } };
    },
    async () => ({ nomeCliente: "joad lima", servico: "Manicure e Pedicure", dataInicio: "2026-11-04T09:00:00" })
  );
  assert.equal(resultado.eventId, "evt_isento_teste");
  assert.deepEqual(enviado, {
    acao: "CANCELAR", eventId: "evt_isento_teste",
    nomeCliente: "joad lima", servico: "Manicure e Pedicure", dataInicio: "2026-11-04T09:00:00"
  });
});
