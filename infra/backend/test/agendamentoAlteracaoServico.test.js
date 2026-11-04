import test from "node:test";
import assert from "node:assert/strict";
import {
  atenderAlteracaoServico,
  enviarAtualizacaoCalendar,
  processarProximaAlteracaoServico,
} from "../src/agendamentoAlteracaoServico.js";
import {
  calcularRestanteServicoCentavos,
  validarNovoPeriodoServico,
  possuiConflitoNovoPeriodo,
} from "../src/agendamentoAlteracaoServicoRegras.mjs";

const ADMIN = "admin-1";
const UID = "cliente-1";
const APPT = "agendamento-1";
const OP = "11111111-1111-4111-8111-111111111111";
const DATE = "2026-11-05";
const CHARGE = "charge-1";

function clone(value) { return value === undefined ? undefined : structuredClone(value); }

function criarFixture(options = {}) {
  const state = {
    docs: new Map([
      [`usuarios/${ADMIN}`, { role: "admin", ativo: true }],
      [`agendamentos/${APPT}`, {
        clienteId: UID, nomeCliente: "Cliente", data: DATE, horario: "11:00",
        status: "confirmado", servico: "Serviço anterior", idServico: "old",
        duracao: 120, duracaoSnapshot: 120, precoSnapshot: 200,
        pixCobrancaId: CHARGE, pixReservaId: "reservation-1",
        valorSinalCentavos: 5000, valorRestanteCentavos: 15000,
        calendarEventId: "evt_agendamento-1",
      }],
      ["servicos/new", { nome: "Serviço novo", preco: 125, duracao: 60, ativo: true }],
      ["servicos/long", { nome: "Serviço longo", preco: 180, duracao: 180, ativo: true }],
      ["servicos/pedicure", { nome: "Pedicure Simples", categoria: "Pedicure", preco: 80, duracao: 60, ativo: true }],
    ]),
    history: new Map(),
    operations: new Map(),
    reservation: {
      reserva_id: "reservation-1", cliente_uid: UID, reserva_servico_id: "old",
      reserva_data: DATE, reserva_inicio: 660, reserva_fim: 780,
      reserva_estado: "confirmada", cobranca_id: CHARGE, agendamento_id: APPT,
      cobranca_estado: "paga", valor_sinal_centavos: 5000,
      cobranca_agendamento_id: APPT,
    },
    charge: { id: CHARGE, estado: "paga", valor_sinal_centavos: 5000, mp_order_id: "ord-keep" },
    conflicts: [],
    block: false,
    failCommitOnce: false,
    failFirestoreOnce: false,
    failCleanupOnce: Boolean(options.failCleanupOnce),
    firestoreTxCount: 0,
    calendarPayloads: [],
  };

  const query = (name, field, value) => ({ kind: "query", name, field, value, get: async () => queryDocs(name, field, value) });
  const ref = (name, id) => {
    const path = `${name}/${id}`;
    return {
      id, path, name,
      async get() { const data = state.docs.get(path); return { exists: Boolean(data), data: () => clone(data) }; },
      collection(child) {
        return { doc(childId) {
          const nestedPath = `${path}/${child}/${childId}`;
          return { id: childId, path: nestedPath, async get() {
            const data = state.history.get(nestedPath);
            return { exists: Boolean(data), data: () => clone(data) };
          } };
        } };
      },
    };
  };
  const db = {
    collection(name) {
      return {
        doc(id) { return ref(name, id); },
        where(field, operator, value) { assert.equal(operator, "=="); return query(name, field, value); },
        async get() { return queryDocs(name); },
      };
    },
    async runTransaction(callback) {
      let release;
      const previous = state.firestoreQueue || Promise.resolve();
      state.firestoreQueue = new Promise((resolve) => { release = resolve; });
      await previous;
      const writes = [];
      const tx = {
        async get(target) {
          if (target?.kind === "query") return queryDocs(target.name, target.field, target.value);
          const data = state.docs.get(target.path);
          return { exists: Boolean(data), data: () => clone(data) };
        },
        update(target, data) { writes.push(() => {
          const merged = { ...state.docs.get(target.path), ...clone(data) };
          for (const [key, value] of Object.entries(merged)) if (value === "__DELETE_FIELD__") delete merged[key];
          state.docs.set(target.path, merged);
        }); },
        create(target, data) { writes.push(() => state.history.set(target.path, clone(data))); },
      };
      try {
        const result = await callback(tx);
        state.firestoreTxCount++;
        if (state.failFirestoreOnce) { state.failFirestoreOnce = false; throw new Error("Firestore write failed"); }
        if (state.failCleanupOnce && state.firestoreTxCount === 3) {
          state.failCleanupOnce = false;
          throw new Error("Firestore cleanup failure");
        }
        writes.forEach((write) => write());
        return result;
      } finally { release(); }
    },
  };

  function queryDocs(name, field, value) {
    const prefix = `${name}/`;
    const docs = [...state.docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => clone(data) }))
      .filter((doc) => field ? doc.data()?.[field] === value : true);
    return { docs };
  }

  let pgQueue = Promise.resolve();
  const pool = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.startsWith("insert into public.agendamento_alteracoes_servico")) {
        const [operationId, agendamentoId, adminUid, serviceId] = params;
        if (!state.operations.has(operationId)) state.operations.set(operationId, {
          operation_id: operationId, agendamento_id: agendamentoId,
          admin_uid: adminUid, servico_novo_id: serviceId,
          estado: "solicitada", calendar_estado: "pendente",
          proxima_tentativa_em: new Date(),
        });
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith("select * from public.agendamento_alteracoes_servico")) {
        const op = state.operations.get(params[0]);
        return { rowCount: op ? 1 : 0, rows: op ? [clone(op)] : [] };
      }
      if (normalized.startsWith("select operation_id, estado, calendar_estado")) {
        const op = state.operations.get(params[0]);
        return { rowCount: op && op.admin_uid === params[1] ? 1 : 0, rows: op ? [clone(op)] : [] };
      }
      if (normalized.startsWith("select r.id as reserva_id")) {
        return { rowCount: state.reservation ? 1 : 0, rows: state.reservation ? [clone(state.reservation)] : [] };
      }
      if (normalized.startsWith("with proxima as")) {
        const entry = [...state.operations.values()].find((item) =>
          item.estado === "solicitada" || (item.estado === "concluida" && item.ultimo_erro === params[0]));
        return { rowCount: entry ? 1 : 0, rows: entry ? [{ operation_id: entry.operation_id, estado: entry.estado }] : [] };
      }
      if (normalized.startsWith("update public.agendamento_alteracoes_servico set ultimo_erro = $2")) {
        const entry = state.operations.get(params[0]);
        if (entry) Object.assign(entry, { ultimo_erro: params[1] });
        return { rowCount: entry ? 1 : 0, rows: [] };
      }
      if (normalized.startsWith("update public.agendamento_alteracoes_servico set ultimo_erro = null")) {
        const entry = state.operations.get(params[0]);
        if (entry) Object.assign(entry, { ultimo_erro: null });
        return { rowCount: entry ? 1 : 0, rows: [] };
      }
      if (normalized.startsWith("update public.agendamento_alteracoes_servico set bloqueado_ate = null")) {
        const entry = state.operations.get(params[0]);
        return { rowCount: entry ? 1 : 0, rows: [] };
      }
      if (normalized.startsWith("update public.agendamento_alteracoes_servico set cliente_uid")) {
        const op = state.operations.get(params[0]);
        if (op) Object.assign(op, {
          cliente_uid: params[1], nome_cliente: params[2], data_servico: params[3],
          inicio_minuto: params[4], calendar_event_id: params[5],
          servico_anterior_id: params[6], servico_anterior_nome: params[7],
          duracao_anterior: params[8], preco_anterior_centavos: params[9],
          servico_novo_nome: params[10], duracao_nova: params[11],
          preco_novo_centavos: params[12], sinal_pago_centavos: params[13],
          restante_novo_centavos: Math.max(0, params[12] - params[13]),
        });
        return { rowCount: op ? 1 : 0, rows: [] };
      }
      if (normalized.startsWith("update public.agendamento_alteracoes_servico set estado = case")) {
        const op = state.operations.get(params[0]);
        if (op) Object.assign(op, { estado: params[1] ? "falha_permanente" : "solicitada", calendar_estado: params[1] ? "falha" : "pendente", ultimo_erro: params[2] });
        return { rowCount: op ? 1 : 0, rows: [] };
      }
      if (normalized.startsWith("update public.agendamento_alteracoes_servico set estado = 'falha_permanente'")) {
        const op = state.operations.get(params[0]);
        if (op && op.estado !== "concluida") Object.assign(op, { estado: "falha_permanente", calendar_estado: "falha", ultimo_erro: params[1] });
        return { rowCount: op ? 1 : 0, rows: [] };
      }
      throw new Error(`pool.query inesperada: ${normalized}`);
    },
    async connect() {
      let release;
      let transactionWrites = [];
      return {
        async query(sql, params = []) {
          const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (normalized === "begin") {
            const previous = pgQueue;
            pgQueue = new Promise((resolve) => { release = resolve; });
            await previous;
            return { rowCount: null, rows: [] };
          }
          if (normalized === "commit") {
            if (state.failCommitOnce) { state.failCommitOnce = false; throw new Error("commit failed"); }
            transactionWrites.forEach((write) => write());
            transactionWrites = [];
            release?.(); release = null;
            return { rowCount: null, rows: [] };
          }
          if (normalized === "rollback") {
            transactionWrites = [];
            release?.(); release = null;
            return { rowCount: null, rows: [] };
          }
          if (normalized.startsWith("select pg_advisory_xact_lock")) return { rowCount: null, rows: [] };
          if (normalized.startsWith("select operation_id from public.agendamento_alteracoes_servico")) return { rowCount: 1, rows: [] };
          if (normalized.startsWith("select 1 from public.pix_reservas")) {
            const [date, ownId, start, end] = params;
            const occupied = state.conflicts.some((item) => item.data === date && item.agendamento_id !== ownId && item.estado === "reservada" && start < item.fim && end > item.inicio);
            return { rowCount: occupied ? 1 : 0, rows: occupied ? [{}] : [] };
          }
          if (normalized.startsWith("update public.pix_reservas")) {
            const [reservationId, serviceId, end, appointmentId, clientUid] = params;
            const r = state.reservation;
            if (!r || r.reserva_id !== reservationId || r.agendamento_id !== appointmentId || r.cliente_uid !== clientUid) return { rowCount: 0, rows: [] };
            transactionWrites.push(() => Object.assign(r, { reserva_servico_id: serviceId, reserva_fim: end }));
            return { rowCount: 1, rows: [] };
          }
          if (normalized.startsWith("insert into public.pix_reservas")) {
            const [clientUid, serviceId, date, start, end, appointmentId] = params;
            transactionWrites.push(() => { state.reservation = { reserva_id: "new-reservation", cliente_uid: clientUid, reserva_servico_id: serviceId, reserva_data: date, reserva_inicio: start, reserva_fim: end, reserva_estado: "confirmada", cobranca_id: null, agendamento_id: appointmentId }; });
            return { rowCount: 1, rows: [] };
          }
          if (normalized.startsWith("update public.agendamento_alteracoes_servico set estado = 'concluida'")) {
            const op = state.operations.get(params[0]);
            transactionWrites.push(() => Object.assign(op, { estado: "concluida", calendar_estado: "enviado", ultimo_erro: null }));
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`client.query inesperada: ${normalized}`);
        },
        release() { if (release) { release(); release = null; } },
      };
    },
  };

  const dependencies = {
    firestore: db,
    verificarUsuario: async () => options.userUid || ADMIN,
    FieldValue: { serverTimestamp: () => "server-timestamp", delete: () => "__DELETE_FIELD__" },
    validarNovoPeriodo: (data, horario, duracao, servico) => {
      const start = Number(horario.slice(0, 2)) * 60 + Number(horario.slice(3, 5));
      if (options.periodRejected) return { valido: false, motivo: options.periodRejected };
      return { valido: true, inicioMinuto: start, fimMinuto: start + duracao };
    },
    possuiBloqueio: async () => Boolean(options.block),
  };
  if (!options.defaultCalendar) {
    dependencies.enviarCalendar = async (payload) => { state.calendarPayloads.push(clone(payload)); if (options.failCalendar) throw options.failCalendar; };
  } else {
    dependencies.fetch = async (_url, request) => {
      state.calendarPayloads.push(JSON.parse(request.body));
      return { ok: true, async text() { return JSON.stringify(options.calendarResponse); } };
    };
  }
  if (options.userUid && options.userUid !== ADMIN) {
    state.docs.set(`usuarios/${options.userUid}`, { role: "cliente", ativo: true });
  }
  if (options.inactiveAdmin) state.docs.set(`usuarios/${ADMIN}`, { role: "admin", ativo: false });
  if (options.status) state.docs.set(`agendamentos/${APPT}`, { ...state.docs.get(`agendamentos/${APPT}`), status: options.status });
  if (options.fsConflict) state.docs.set("agendamentos/other", { data: DATE, horario: "12:00", duracao: 60, status: "confirmado" });
  if (options.pixConflict) state.conflicts.push({ data: DATE, inicio: 700, fim: 730, estado: "reservada", agendamento_id: "pix-other" });
  if (options.block) dependencies.possuiBloqueio = async () => true;
  if (options.missingCalendarId) {
    const appt = state.docs.get(`agendamentos/${APPT}`); delete appt.calendarEventId;
  }

  return { state, pool, dependencies };
}

function request(operationId = OP, serviceId = "new", adminUid = ADMIN, extra = {}) {
  const bytes = Buffer.from(JSON.stringify({ agendamentoId: APPT, servicoId: serviceId, operationId, ...extra }));
  return { method: "PATCH", url: "/admin/agendamentos/servico", headers: {}, async *[Symbol.asyncIterator]() { yield bytes; }, adminUid };
}

function response() {
  return { status: 0, headers: {}, body: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(text) { this.body = JSON.parse(text); } };
}

async function execute(fixture, req = request()) {
  const res = response();
  await atenderAlteracaoServico(req, res, fixture.pool, fixture.dependencies);
  return res;
}

test("troca por serviço menor encurta a reserva sem mover o início", async () => {
  const fixture = criarFixture();
  const res = await execute(fixture);
  assert.equal(res.status, 200, JSON.stringify({ body: res.body, op: fixture.state.operations.get(OP) }));
  assert.equal(fixture.state.reservation.reserva_inicio, 660);
  assert.equal(fixture.state.reservation.reserva_fim, 720);
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).duracao, 60);
  assert.equal("alteracaoServicoOperacaoPendente" in fixture.state.docs.get(`agendamentos/${APPT}`), false);
});

test("intervalo excedente fica liberado após encurtar a reserva", async () => {
  const fixture = criarFixture();
  await execute(fixture);
  assert.equal(fixture.state.reservation.reserva_fim, 720);
  assert.equal(possuiConflitoNovoPeriodo(720, 750, [{ inicio: 660, fim: fixture.state.reservation.reserva_fim }]), false);
});

test("troca por serviço mais longo é aceita quando há disponibilidade", async () => {
  const fixture = criarFixture();
  const res = await execute(fixture, request(OP, "long"));
  assert.equal(res.status, 200);
  assert.equal(fixture.state.reservation.reserva_fim, 840);
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).duracao, 180);
});

test("backend ignora preço e duração enviados pelo navegador", async () => {
  const fixture = criarFixture();
  const res = await execute(fixture, request(OP, "new", ADMIN, { preco: 1, duracao: 1 }));
  assert.equal(res.status, 200);
  const atual = fixture.state.docs.get(`agendamentos/${APPT}`);
  assert.equal(atual.precoSnapshot, 125);
  assert.equal(atual.duracao, 60);
});

test("conflito com agendamento confirmado responde 409 sem gravar alterações", async () => {
  const fixture = criarFixture({ fsConflict: true });
  const res = await execute(fixture, request(OP, "long"));
  assert.equal(res.status, 409);
  assert.equal(fixture.state.reservation.reserva_fim, 780);
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).idServico, "old");
  assert.equal(fixture.state.calendarPayloads.length, 0);
});

test("conflito com reserva PIX pendente responde 409", async () => {
  const fixture = criarFixture({ pixConflict: true });
  const res = await execute(fixture, request(OP, "long"));
  assert.equal(res.status, 409);
  assert.equal(fixture.state.reservation.reserva_fim, 780);
});

test("bloqueio administrativo impede a alteração", async () => {
  const fixture = criarFixture({ block: true });
  const res = await execute(fixture, request(OP, "long"));
  assert.equal(res.status, 409);
  assert.equal(fixture.state.calendarPayloads.length, 0);
});

test("regras de sábado e as restrições especiais de dezembro continuam valendo", () => {
  assert.equal(validarNovoPeriodoServico({ data: "2026-11-07", horario: "16:00", duracao: 150, servico: { nome: "Manutenção" }, now: new Date("2026-11-04T12:00:00-03:00") }).valido, true);
  assert.equal(validarNovoPeriodoServico({ data: "2026-11-07", horario: "16:30", duracao: 60, servico: { nome: "Manutenção" }, now: new Date("2026-11-04T12:00:00-03:00") }).valido, false);
  assert.equal(validarNovoPeriodoServico({ data: "2026-12-18", horario: "14:00", duracao: 60, servico: { nome: "Pedicure Simples", categoria: "Pedicure" }, now: new Date("2026-11-04T12:00:00-03:00") }).valido, false);
});

test("preserva cobrança paga, identificadores e valor recebido", async () => {
  const fixture = criarFixture();
  const cobrancaOriginal = clone(fixture.state.charge);
  const apptOriginal = clone(fixture.state.docs.get(`agendamentos/${APPT}`));
  await execute(fixture);
  const atualizado = fixture.state.docs.get(`agendamentos/${APPT}`);
  assert.equal(atualizado.pixCobrancaId, apptOriginal.pixCobrancaId);
  assert.equal(atualizado.pixReservaId, apptOriginal.pixReservaId);
  assert.equal(atualizado.valorSinalCentavos, apptOriginal.valorSinalCentavos);
  assert.equal(fixture.state.charge.mp_order_id, cobrancaOriginal.mp_order_id);
  assert.equal(fixture.state.charge.valor_sinal_centavos, cobrancaOriginal.valor_sinal_centavos);
});

test("calcula o restante do novo serviço em centavos", () => {
  assert.equal(calcularRestanteServicoCentavos(12500, 5000), 7500);
});

test("sinal pago acima do novo preço produz restante zero, nunca negativo", () => {
  assert.equal(calcularRestanteServicoCentavos(4000, 5000), 0);
});

test("usuário não administrador recebe 403 e nenhuma operação é registrada", async () => {
  const fixture = criarFixture({ userUid: "cliente-1" });
  const res = await execute(fixture);
  assert.equal(res.status, 403);
  assert.equal(fixture.state.operations.size, 0);
});

test("administradora inativa não pode solicitar alteração", async () => {
  const fixture = criarFixture({ inactiveAdmin: true });
  const res = await execute(fixture);
  assert.equal(res.status, 403);
  assert.equal(fixture.state.operations.size, 0);
});

test("agendamentos não confirmados, cancelados e concluídos são rejeitados", async (t) => {
  for (const status of ["agendado", "cancelado_cliente", "concluido"]) {
    await t.test(status, async () => {
      const fixture = criarFixture({ status });
      const res = await execute(fixture);
      assert.equal(res.status, 409);
      assert.equal(fixture.state.reservation.reserva_fim, 780);
      assert.equal(fixture.state.calendarPayloads.length, 0);
    });
  }
});

test("solicitações simultâneas com a mesma chave não criam histórico duplicado", async () => {
  const fixture = criarFixture();
  const respostas = await Promise.all([execute(fixture), execute(fixture)]);
  assert.ok(respostas.every((res) => res.status === 200));
  assert.equal(fixture.state.history.size, 1);
  assert.equal(fixture.state.reservation.reserva_fim, 720);
});

test("falha de commit pode ser recuperada repetindo a mesma operação", async () => {
  const fixture = criarFixture();
  fixture.state.failCommitOnce = true;
  const primeira = await execute(fixture);
  assert.equal(primeira.status, 202);
  assert.equal(fixture.state.reservation.reserva_fim, 780);
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).alteracaoServicoOperacaoId, OP);
  const segunda = await execute(fixture);
  assert.equal(segunda.status, 200);
  assert.equal(fixture.state.reservation.reserva_fim, 720);
  assert.equal(fixture.state.operations.get(OP).estado, "concluida");
});

test("Calendar recebe ação de atualização com eventId estável e confirmação explícita", async () => {
  const fixture = criarFixture();
  await execute(fixture);
  assert.equal(fixture.state.calendarPayloads[0].calendar_event_id, "evt_agendamento-1");
  const sent = [];
  const result = await enviarAtualizacaoCalendar({
    operation_id: OP, calendar_event_id: "evt_stable", nome_cliente: "Cliente",
    novo_servico_nome: "Novo", data_servico: DATE, inicio_minuto: 660, duracao_nova: 60,
  }, async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, async text() { return JSON.stringify({ ok: true, updated: true, eventId: "evt_stable" }); } };
  });
  assert.equal(result.eventId, "evt_stable");
  assert.equal(sent[0].acao, "ATUALIZAR");
  assert.equal(sent[0].operationId, OP);
});

test("se o Calendar não confirmar atualização, não altera Firestore nem reserva", async () => {
  const fixture = criarFixture({ defaultCalendar: true, calendarResponse: { ok: true, eventId: "evt_agendamento-1" } });
  const res = await execute(fixture);
  assert.equal(res.status, 409);
  assert.equal(fixture.state.reservation.reserva_fim, 780);
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).idServico, "old");
  assert.equal("alteracaoServicoOperacaoPendente" in fixture.state.docs.get(`agendamentos/${APPT}`), false);
});

test("sem eventId estável, recusa a operação para não duplicar evento", async () => {
  const fixture = criarFixture({ missingCalendarId: true });
  const res = await execute(fixture);
  assert.equal(res.status, 409);
  assert.equal(fixture.state.reservation.reserva_fim, 780);
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).idServico, "old");
});

test("marcador de alteração permanece até o COMMIT e é liberado após sucesso", async () => {
  const fixture = criarFixture();
  const originalQuery = fixture.pool.connect.bind(fixture.pool);
  let markerBeforeCommit;
  fixture.pool.connect = async () => {
    const connection = await originalQuery();
    const oldQuery = connection.query.bind(connection);
    connection.query = async (sql, params) => {
      if (String(sql).toLowerCase() === "commit") {
        markerBeforeCommit = fixture.state.docs.get(`agendamentos/${APPT}`).alteracaoServicoOperacaoPendente;
      }
      return oldQuery(sql, params);
    };
    return connection;
  };
  const res = await execute(fixture);
  assert.equal(res.status, 200);
  assert.equal(markerBeforeCommit, OP);
  assert.equal("alteracaoServicoOperacaoPendente" in fixture.state.docs.get(`agendamentos/${APPT}`), false);
});

test("falha de limpeza após COMMIT mantém bloqueio e worker libera sem reexecutar Calendar", async () => {
  const fixture = criarFixture({ failCleanupOnce: true });
  const res = await execute(fixture);
  assert.equal(res.status, 200);
  assert.equal(fixture.state.operations.get(OP).estado, "concluida");
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).alteracaoServicoOperacaoPendente, OP);
  const before = fixture.state.calendarPayloads.length;
  const retry = await processarProximaAlteracaoServico(fixture.pool, fixture.dependencies);
  assert.equal(retry.marcadorLiberado, true);
  assert.equal(fixture.state.operations.get(OP).ultimo_erro, null);
  assert.equal("alteracaoServicoOperacaoPendente" in fixture.state.docs.get(`agendamentos/${APPT}`), false);
  assert.equal(fixture.state.calendarPayloads.length, before);
});

test("reuso de chave idempotente incompatível não invalida operação de outro serviço", async () => {
  const fixture = criarFixture();
  const original = await execute(fixture);
  assert.equal(original.status, 200);
  const conflict = await execute(fixture, request(OP, "long"));
  assert.equal(conflict.status, 409);
  assert.equal(fixture.state.operations.get(OP).estado, "concluida");
  assert.equal(fixture.state.docs.get(`agendamentos/${APPT}`).idServico, "new");
});
