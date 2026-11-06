import test from "node:test";
import assert from "node:assert/strict";
import {
  alterarIsencaoPix,
  criarAgendamentoIsento,
  reagendarComBloqueio,
} from "../src/agendamentosIsencaoPix.js";
import { identificarNotificacoesAgendamento } from "../src/agendaNotificacoes.js";

const UID = "cliente-1";
const ADMIN = "admin-1";
const CHAVE = "11111111-1111-4111-8111-111111111111";
const DATA = "2026-11-05";

function criarFixture({ isenta = true, reservas = [], documentos = {}, falharCommit = false, falharFirestore = false, marcarPendenteAntesTransacao = false } = {}) {
  const state = {
    isencoes: new Map(isenta ? [[UID, true]] : []),
    reservas,
    documentos: new Map(Object.entries({
      "servicos/s1": { ativo: true, nome: "Manicure", preco: 80, duracao: 60 },
      "clientes/cliente-1": { nome: "Cliente Um" },
      "usuarios/admin-1": { role: "admin", ativo: true },
      ...documentos,
    })),
    falharCommit,
    falharFirestore,
    sqlStatements: [],
  };
  let firestoreQueue = Promise.resolve();
  let postgresQueue = Promise.resolve();
  const firestore = {
    collection(nome) {
      return {
        doc(id) {
          const path = `${nome}/${id}`;
          return {
            id,
            path,
            async get() { return snapshot(state.documentos, path); },
          };
        },
        where(campo, operador, valor) { return { nome, campo, operador, valor }; },
      };
    },
    async runTransaction(callback) {
      let liberar;
      const anterior = firestoreQueue;
      firestoreQueue = new Promise((resolve) => { liberar = resolve; });
      await anterior;
      const operacoes = [];
      // Simula uma alteração concorrente após a leitura inicial do agendamento.
      if (marcarPendenteAntesTransacao) {
        marcarPendenteAntesTransacao = false;
        const atual = state.documentos.get("agendamentos/original");
        if (atual) state.documentos.set("agendamentos/original", { ...atual, alteracaoServicoOperacaoPendente: "op-concorrente" });
      }
      const tx = {
        async get(ref) {
          if (ref?.nome) {
            const docs = [...state.documentos.entries()]
              .filter(([path]) => path.startsWith(`${ref.nome}/`))
              .map(([path, dados]) => ({
                id: path.slice(ref.nome.length + 1), data: () => structuredClone(dados),
              }))
              .filter((doc) => doc.data()?.[ref.campo] === ref.valor);
            return { docs };
          }
          return snapshot(state.documentos, ref.path);
        },
        create(ref, dados) { operacoes.push(() => state.documentos.set(ref.path, structuredClone(dados))); },
        update(ref, dados) {
          operacoes.push(() => state.documentos.set(ref.path, { ...state.documentos.get(ref.path), ...structuredClone(dados) }));
        },
        set(ref, dados) { operacoes.push(() => state.documentos.set(ref.path, structuredClone(dados))); },
        delete(ref) { operacoes.push(() => state.documentos.delete(ref.path)); },
      };
      try {
        const retorno = await callback(tx);
        if (state.falharFirestore) {
          state.falharFirestore = false;
          throw new Error("simulated Firestore failure");
        }
        for (const operacao of operacoes) operacao();
        return retorno;
      } finally { liberar(); }
    },
  };

  function snapshot(map, path) {
    const data = map.get(path);
    return { exists: Boolean(data), data: () => structuredClone(data) };
  }

  const pool = {
    async query(sql, params = []) {
      state.sqlStatements.push(sql);
      if (sql.includes("SELECT ativa") && sql.includes("cliente_uid = $1")) {
        return { rows: state.isencoes.has(params[0]) ? [{ ativa: state.isencoes.get(params[0]) }] : [], rowCount: state.isencoes.has(params[0]) ? 1 : 0 };
      }
      if (sql.includes("SELECT cliente_uid FROM public.cliente_pix_isencoes")) {
        return { rows: [...state.isencoes].filter(([, ativa]) => ativa).map(([cliente_uid]) => ({ cliente_uid })), rowCount: 1 };
      }
      if (sql.includes("INSERT INTO public.cliente_pix_isencoes")) {
        state.isencoes.set(params[0], !sql.includes("VALUES ($1, FALSE")); return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE public.cliente_pix_isencoes")) {
        state.isencoes.set(params[0], false); return { rows: [], rowCount: 1 };
      }
      throw new Error(`SQL global inesperado: ${sql}`);
    },
    async connect() {
      let release;
      let pendingReservations;
      return {
        async query(sql, params = []) {
          state.sqlStatements.push(sql);
          if (sql === "BEGIN") {
            pendingReservations = [];
            const anterior = postgresQueue;
            postgresQueue = new Promise((resolve) => { release = resolve; });
            await anterior;
            return { rows: [], rowCount: 0 };
          }
          if (sql === "COMMIT") {
            if (state.falharCommit) { state.falharCommit = false; release?.(); release = null; pendingReservations = null; throw new Error("simulated commit failure"); }
            for (const update of pendingReservations || []) {
              if (update.tipo === "insert") state.reservas.push(update.registro);
              if (update.tipo === "update") Object.assign(state.reservas.find((r) => r.id === update.id), update.dados);
            }
            release?.(); release = null;
            return { rows: [], rowCount: 0 };
          }
          if (sql === "ROLLBACK") { pendingReservations = null; release?.(); release = null; return { rows: [], rowCount: 0 }; }
          if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
          if (sql.includes("FROM public.agenda_bloqueios")) {
             return { rows: [], rowCount: 0 };
           }
           if (sql.includes("SELECT ativa") && sql.includes("FOR SHARE")) {
            const ativa = state.isencoes.get(params[0]) === true;
            return { rows: ativa ? [{ ativa: true }] : [], rowCount: ativa ? 1 : 0 };
          }
          if (sql.includes("SELECT id, cliente_uid, cobranca_id") && sql.includes("agendamento_id = $1")) {
            const registro = state.reservas.find((r) => r.agendamentoId === params[0] || r.agendamento_id === params[0]);
            return { rows: registro ? [{ id: registro.id || "reserva-persistida", cliente_uid: registro.clienteUid || registro.cliente_uid, cobranca_id: registro.cobrancaId ?? registro.cobranca_id ?? null }] : [], rowCount: registro ? 1 : 0 };
          }
          if (sql.includes("FROM public.pix_reservas")) {
            const [data, inicio, fim] = params;
            const lista = [...state.reservas, ...(pendingReservations || []).filter((r) => r.tipo === "insert").map((r) => r.registro)];
            const excluido = params[3];
            const temExcecao = sql.includes("AND NOT (");
            const uid = temExcecao ? params[3] : null;
            const encontrados = lista.filter((reserva) => reserva.data === data &&
              ["reservada", "confirmada"].includes(reserva.estado) &&
              (!temExcecao && excluido !== undefined
                ? (reserva.agendamentoId || reserva.agendamento_id) !== excluido : true) &&
              inicio < reserva.fim + 15 && fim > reserva.inicio - 15 &&
              !(temExcecao && reserva.estado === "confirmada" &&
                (reserva.clienteUid || reserva.cliente_uid) === uid &&
                (reserva.fim === inicio || reserva.inicio === fim)));
            return { rows: encontrados, rowCount: encontrados.length };
          }
          if (sql.includes("INSERT INTO public.pix_reservas")) {
            const [id, clienteUid, servicoId, data, inicio, fim, agendamentoId] = params;
            pendingReservations.push({ tipo: "insert", registro: { id, clienteUid, servicoId, data, inicio, fim, estado: "confirmada", cobrancaId: null, agendamentoId } });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("UPDATE public.pix_reservas")) {
            const [id, servicoId, data, inicio, fim] = params;
            pendingReservations.push({ tipo: "update", id, dados: { servicoId, data, inicio, fim, estado: "confirmada" } });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO public.pix_calendar_outbox")) return { rows: [], rowCount: 1 };
          throw new Error(`SQL transacional inesperado: ${sql}`);
        },
        release() { pendingReservations = null; release?.(); release = null; },
      };
    },
  };
  const dependencies = { serverTimestamp: "SERVER_TIME", now: new Date("2026-11-02T12:00:00Z") };
  return { pool, firestore, state, dependencies };
}

function payload(chave = CHAVE, horario = "14:00") {
  return { servicoId: "s1", data: DATA, horario, chaveIdempotencia: chave, observacoes: "" };
}

test("cliente comum continua obrigada a pagar PIX", async () => {
  const f = criarFixture({ isenta: false });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    (erro) => erro.codigo === "ISENCAO_INATIVA",
  );
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 0);
  assert.equal(f.state.sqlStatements.some((sql) => /insert\s+into\s+public\.pix_cobrancas/i.test(sql)), false);
});

test("cliente isenta confirma agendamento sem criar cobrança PIX", async () => {
  const f = criarFixture();
  const resultado = await criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: { ...payload(), clienteUid: "outra-cliente" }, dependencies: f.dependencies });
  const documento = f.state.documentos.get(`agendamentos/${resultado.agendamentoId}`);
  assert.equal(resultado.agendamentoConfirmado, true);
  assert.equal(documento.status, "confirmado");
  assert.equal(documento.origemPagamento, "isencao_sinal_pix");
  assert.equal(documento.clienteId, UID);
  assert.equal(documento.sinalPixIsento, true);
  assert.equal(f.state.sqlStatements.filter((sql) => sql.includes("INSERT INTO public.pix_calendar_outbox")).length, 1);
  assert.equal("pixCobrancaId" in documento, false);
  assert.equal(f.state.sqlStatements.some((sql) => /insert\s+into\s+public\.pix_cobrancas/i.test(sql)), false);
});

test("repetição idempotente retorna o agendamento existente mesmo após revogação", async () => {
  const f = criarFixture();
  const primeiro = await criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies });
  f.state.isencoes.set(UID, false);
  const repetido = await criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies });
  assert.equal(repetido.agendamentoId, primeiro.agendamentoId);
  assert.equal(repetido.idempotente, true);
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 1);
});

test("cliente não autorizada não consegue conceder isenção a si mesma", async () => {
  const f = criarFixture({ isenta: false });
  await assert.rejects(
    alterarIsencaoPix({ pool: f.pool, db: f.firestore, adminUid: UID, clienteUid: UID, ativa: true }),
    (erro) => erro.status === 403,
  );
  assert.equal(f.state.isencoes.has(UID), false);
});

test("administradora pode conceder a permissão à cliente cadastrada", async () => {
  const f = criarFixture({ isenta: false });
  const resultado = await alterarIsencaoPix({ pool: f.pool, db: f.firestore, adminUid: ADMIN, clienteUid: UID, ativa: true });
  assert.deepEqual(resultado, { clienteUid: UID, ativa: true });
  assert.equal(f.state.isencoes.get(UID), true);
});

test("revogar a isenção obriga pagamentos nos novos agendamentos", async () => {
  const f = criarFixture();
  await alterarIsencaoPix({ pool: f.pool, db: f.firestore, adminUid: ADMIN, clienteUid: UID, ativa: false });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    (erro) => erro.codigo === "ISENCAO_INATIVA",
  );
  assert.equal(f.state.isencoes.get(UID), false);
});

test("horário ocupado no Firestore continua bloqueado", async () => {
  const f = criarFixture({ documentos: {
    "agendamentos/outro": { clienteId: "cliente-2", data: DATA, horario: "14:00", duracao: 60, status: "confirmado" },
  } });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    (erro) => erro.codigo === "HORARIO_OCUPADO",
  );
});

test("reserva PIX pendente ocupa o horário para o fluxo isento", async () => {
  const f = criarFixture({ reservas: [{ data: DATA, inicio: 840, fim: 900, estado: "reservada" }] });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    (erro) => erro.codigo === "HORARIO_RESERVADO_PIX",
  );
});

test("duas confirmações concorrentes não duplicam o mesmo horário", async () => {
  const f = criarFixture();
  const resultados = await Promise.allSettled([
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE), dependencies: f.dependencies }),
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload("22222222-2222-4222-8222-222222222222"), dependencies: f.dependencies }),
  ]);
  assert.equal(resultados.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(resultados.filter((item) => item.status === "rejected").length, 1);
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 1);
});

test("cancelamento prévio libera o horário e não afeta o financeiro PIX", async () => {
  const f = criarFixture({ documentos: {
    "agendamentos/cancelado": { clienteId: "cliente-2", data: DATA, horario: "14:00", duracao: 60, status: "cancelado_cliente", pixStatusFinanceiro: "pago" },
  } });
  const resultado = await criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies });
  assert.equal(f.state.documentos.get(`agendamentos/${resultado.agendamentoId}`).status, "confirmado");
  assert.equal(f.state.documentos.get("agendamentos/cancelado").pixStatusFinanceiro, "pago");
});

test("falha parcial no commit PostgreSQL compensa o documento Firestore", async () => {
  const f = criarFixture({ falharCommit: true });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    /simulated commit failure/,
  );
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 0);
});

test("falha no Firestore faz rollback da reserva PostgreSQL", async () => {
  const f = criarFixture({ falharFirestore: true });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    /simulated Firestore failure/,
  );
  assert.equal(f.state.reservas.length, 0);
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 0);
});

test("reagendamento seguro valida conflito e preserva evento da agenda", async () => {
  const f = criarFixture({ isenta: false, documentos: {
    "agendamentos/original": { clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60, status: "confirmado", calendarEventId: "evt_original" },
  } });
  const resultado = await reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  });
  const atualizado = f.state.documentos.get("agendamentos/original");
  assert.equal(resultado.reagendado, true);
  assert.equal(atualizado.status, "reagendado");
  assert.equal(atualizado.calendarEventId, "evt_original");
  assert.equal(atualizado.data, DATA);
});

test("reagendamento não ocupa horário PIX pendente nem altera o documento", async () => {
  const f = criarFixture({ isenta: false, reservas: [{ data: DATA, inicio: 840, fim: 900, estado: "reservada" }], documentos: {
    "agendamentos/original": { clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60, status: "confirmado", calendarEventId: "evt_original" },
  } });
  await assert.rejects(reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  }), (erro) => erro.codigo === "HORARIO_RESERVADO_PIX");
  assert.equal(f.state.documentos.get("agendamentos/original").data, "2026-11-03");
});

test("reagendamento recusa operação de alteração de serviço já pendente", async () => {
  const f = criarFixture({ isenta: false, documentos: {
    "agendamentos/original": {
      clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60,
      status: "confirmado", calendarEventId: "evt_original",
      alteracaoServicoOperacaoPendente: "op-andamento",
    },
  } });
  await assert.rejects(reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  }), (erro) => erro.status === 409 && erro.codigo === "ALTERACAO_SERVICO_EM_ANDAMENTO");
  assert.equal(f.state.reservas.length, 0);
  assert.equal(f.state.documentos.get("agendamentos/original").data, "2026-11-03");
});

test("reagendamento revalida marcador concorrente dentro da transação Firestore", async () => {
  const f = criarFixture({ isenta: false, marcarPendenteAntesTransacao: true, documentos: {
    "agendamentos/original": {
      clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60,
      status: "confirmado", calendarEventId: "evt_original",
    },
  } });
  await assert.rejects(reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  }), (erro) => erro.status === 409 && erro.codigo === "ALTERACAO_SERVICO_EM_ANDAMENTO");
  assert.equal(f.state.reservas.length, 0);
  assert.equal(f.state.documentos.get("agendamentos/original").data, "2026-11-03");
});

test("agendamento isento gera notificações push para cliente e administradora", () => {
  const eventos = identificarNotificacoesAgendamento(null, {
    id: "isento-1", clienteId: UID, status: "confirmado", data: DATA,
    horario: "13:00", servico: "Manicure", nomeCliente: "Cliente Um",
    origemPagamento: "isencao_sinal_pix",
  });
  assert.deepEqual(eventos.map((evento) => evento.destinatario), ["cliente", "admin"]);
  assert.equal(eventos[0].tipo, "confirmacao_isencao_cliente");
  assert.match(eventos[0].mensagem, /pagar sinal PIX/);
});

test("isenta agenda serviço exatamente após outro confirmado da mesma conta", async () => {
  const f = criarFixture({ reservas: [{
    data: DATA, inicio: 840, fim: 900, estado: "confirmada",
    clienteUid: UID, agendamentoId: "anterior", cobrancaId: null,
  }], documentos: {
    "agendamentos/anterior": {
      clienteId: UID, data: DATA, horario: "14:00", duracao: 60, status: "confirmado",
    },
  } });
  const resultado = await criarAgendamentoIsento({
    pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "15:00"),
    dependencies: f.dependencies,
  });
  assert.equal(resultado.agendamentoConfirmado, true);
  assert.equal(f.state.documentos.get("agendamentos/anterior").horario, "14:00");
  assert.equal(f.state.reservas.length, 2);
});

test("isenta não ignora buffer de outra cliente nem reserva pendente da própria conta", async () => {
  for (const reserva of [
    { clienteUid: "outra", estado: "confirmada" },
    { clienteUid: UID, estado: "reservada" },
  ]) {
    const f = criarFixture({ reservas: [{
      data: DATA, inicio: 840, fim: 900, agendamentoId: "anterior", ...reserva,
    }] });
    await assert.rejects(criarAgendamentoIsento({
      pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "15:00"),
      dependencies: f.dependencies,
    }), (erro) => erro.codigo === "HORARIO_RESERVADO_PIX");
  }
});

test("isenta não permite sobreposição mesmo entre serviços da mesma cliente", async () => {
  const f = criarFixture({ reservas: [{
    data: DATA, inicio: 840, fim: 900, estado: "confirmada",
    clienteUid: UID, agendamentoId: "anterior",
  }], documentos: {
    "agendamentos/anterior": {
      clienteId: UID, data: DATA, horario: "14:00", duracao: 60, status: "confirmado",
    },
  } });
  await assert.rejects(criarAgendamentoIsento({
    pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "14:45"),
    dependencies: f.dependencies,
  }), (erro) => ["HORARIO_RESERVADO_PIX", "HORARIO_OCUPADO", "ENCAIXE_INDISPONIVEL"].includes(erro.codigo));
});
