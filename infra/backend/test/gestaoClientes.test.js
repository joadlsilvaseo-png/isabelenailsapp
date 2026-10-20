import test from "node:test";
import assert from "node:assert/strict";
import { atenderGestaoClientes } from "../src/gestaoClientes.js";

const ADMIN = "admin-1";
const CLIENT = "cliente-1";

function response() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function req(method, url, body) {
  const request = { method, url, headers: {} };
  if (body !== undefined) request[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)); };
  return request;
}

function snapshot(id, data) { return { id, exists: data !== undefined, data: () => structuredClone(data) }; }

function fixture({ admin = true, customers, appointments, reservations, note = "nota privada" } = {}) {
  const profiles = customers || {
    [CLIENT]: { nome: "Ana Cliente", email: "ana@example.test", telefone: "11999990000", dataCadastro: "2025-01-01" },
    "cliente-2": { nome: "Beatriz", email: "bia@example.test" },
    [ADMIN]: { nome: "Admin", role: "admin" },
  };
  const visits = appointments || [
    { id: "done", data: { clienteId: CLIENT, data: "2025-02-10", horario: "10:00", servico: "Manicure", status: "concluido" } },
    { id: "cancelled", data: { idCliente: CLIENT, data: "2025-03-10", horario: "10:00", servico: "Pedicure", status: "cancelado_cliente" } },
    { id: "upcoming", data: { userId: CLIENT, data: "2030-02-10", horario: "11:30", servico: "Alongamento", status: "reagendado" } },
    { id: "other", data: { clienteId: "cliente-2", data: "2030-02-11", status: "confirmado" } },
  ];
  const docs = [
    ...Object.entries(profiles).map(([id, data]) => ({ collection: "clientes", id, data })),
    ...Object.entries(admin ? { [ADMIN]: { role: "admin", ativo: true } } : { [ADMIN]: { role: "cliente", ativo: true } })
      .map(([id, data]) => ({ collection: "usuarios", id, data })),
    ...visits.map(({ id, data }) => ({ collection: "agendamentos", id, data })),
    { collection: "servicos", id: "s1", data: { nome: "Blindagem" } },
  ];
  const firestore = {
    collection(name) {
      const collectionDocs = docs.filter((item) => item.collection === name);
      return {
        doc(id) {
          return { id, async get() { const found = collectionDocs.find((item) => item.id === id); return snapshot(id, found?.data); } };
        },
        orderBy() {
          let limit = 20; let after = "";
          const query = {
            limit(value) { limit = value; return query; },
            startAfter(doc) { after = doc.id; return query; },
            async get() {
              const all = collectionDocs.filter((item) => name !== "clientes" || item.id > after).sort((a, b) => a.id.localeCompare(b.id));
              return { docs: all.slice(0, limit).map((item) => snapshot(item.id, item.data)), empty: all.length === 0 };
            },
          };
          return query;
        },
        where(field, _operator, value) {
          let limit = 200;
          const query = {
            limit(value) { limit = value; return query; },
            async get() {
              const matches = collectionDocs.filter((item) => item.data?.[field] === value).slice(0, limit);
              return { docs: matches.map((item) => snapshot(item.id, item.data)), empty: matches.length === 0 };
            },
          };
          return query;
        },
      };
    },
  };
  const state = { sql: [], notes: note };
  const pool = {
    async query(sql, params) {
      state.sql.push({ sql, params });
      if (sql.includes("FROM public.pix_reservas")) return { rows: reservations || [
        { agendamento_id: null, servico_id: "s1", data_servico: "2030-03-20", inicio_minuto: 780, estado: "reservada" },
      ] };
      if (sql.includes("SELECT nota")) return { rows: state.notes ? [{ nota: state.notes }] : [] };
      if (sql.includes("INSERT INTO public.cliente_observacoes_admin")) {
        state.notes = params[1]; return { rows: [{ nota: params[1], updated_at: "now" }] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };
  return { firestore, pool, state, dependencies: { firestore, verificarUsuario: async () => ADMIN } };
}

test("área de clientes exige identidade e perfil administrativo ativo no backend", async () => {
  const f = fixture();
  const semToken = response();
  await atenderGestaoClientes(req("GET", "/admin/clientes"), semToken, f.pool, {
    firestore: f.firestore, verificarUsuario: async () => { throw new Error("sem token"); },
  });
  assert.equal(semToken.status, 401);
  const cliente = response();
  await atenderGestaoClientes(req("GET", "/admin/clientes"), cliente, f.pool, {
    firestore: f.firestore, verificarUsuario: async () => CLIENT,
  });
  assert.equal(cliente.status, 403);
  assert.equal(f.state.sql.length, 0);
});

test("listagem exclui admins, permite pesquisa e paginação com limite", async () => {
  const f = fixture();
  const primeiro = response();
  await atenderGestaoClientes(req("GET", "/admin/clientes?limit=1"), primeiro, f.pool, f.dependencies);
  assert.equal(primeiro.status, 200);
  assert.equal(primeiro.body.items.length, 1);
  assert.equal(primeiro.body.items[0].id, "cliente-1");
  assert.equal(primeiro.body.hasMore, true);
  assert.equal("role" in primeiro.body.items[0], false);
  const segundaPagina = response();
  await atenderGestaoClientes(req("GET", `/admin/clientes?limit=1&cursor=${primeiro.body.nextCursor}`), segundaPagina, f.pool, f.dependencies);
  assert.equal(segundaPagina.status, 200);
  assert.equal(segundaPagina.body.items[0].id, "cliente-2");

  const busca = response();
  await atenderGestaoClientes(req("GET", "/admin/clientes?q=ANA&limit=50"), busca, f.pool, f.dependencies);
  assert.deepEqual(busca.body.items.map((item) => item.id), [CLIENT]);
  assert.equal(busca.body.items[0].email, "ana@example.test");
});

test("perfil agrega histórico, próximos atendimentos e reserva PIX sem duplicar dados financeiros", async () => {
  const f = fixture();
  const res = response();
  await atenderGestaoClientes(req("GET", `/admin/clientes/${CLIENT}`), res, f.pool, f.dependencies);
  assert.equal(res.status, 200);
  assert.equal(res.body.client.id, CLIENT);
  assert.equal(res.body.completedCount, 1);
  assert.equal(res.body.lastVisit, "2025-02-10");
  assert.equal(res.body.upcoming.some((item) => item.id === "upcoming"), true);
  assert.equal(res.body.upcoming.some((item) => item.status === "Aguardando pagamento PIX"), true);
  assert.equal(res.body.history.some((item) => item.id === "cancelled"), true);
  assert.equal(res.body.completedCount, 1, "cancelados não contam como concluídos");
  assert.equal(res.body.internalNote, "nota privada");
  assert.equal(JSON.stringify(res.body).includes("cobranca_id"), false);
  assert.equal(f.state.sql[0].params[0], CLIENT);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("observações ficam em tabela privada e só podem ser salvas por admin autenticada", async () => {
  const f = fixture();
  const salva = response();
  await atenderGestaoClientes(req("PUT", `/admin/clientes/${CLIENT}/observacoes`, { note: "Preferência por horário da manhã" }), salva, f.pool, f.dependencies);
  assert.equal(salva.status, 200);
  assert.equal(salva.body.nota, "Preferência por horário da manhã");
  assert.match(f.state.sql.at(-1).sql, /INSERT INTO public\.cliente_observacoes_admin/);
  assert.deepEqual(f.state.sql.at(-1).params, [CLIENT, "Preferência por horário da manhã", ADMIN]);

  const negada = response();
  await atenderGestaoClientes(req("PUT", `/admin/clientes/${CLIENT}/observacoes`, { note: "tentativa" }), negada, f.pool, {
    firestore: f.firestore, verificarUsuario: async () => CLIENT,
  });
  assert.equal(negada.status, 403);
  assert.equal(f.state.sql.at(-1).params[1], "Preferência por horário da manhã");
});

test("UID inválido e observação acima do limite são rejeitados", async () => {
  const f = fixture();
  const uid = response();
  await atenderGestaoClientes(req("GET", "/admin/clientes/a%2Fb"), uid, f.pool, f.dependencies);
  assert.equal(uid.status, 400);
  const note = response();
  await atenderGestaoClientes(req("PUT", `/admin/clientes/${CLIENT}/observacoes`, { note: "x".repeat(3001) }), note, f.pool, f.dependencies);
  assert.equal(note.status, 400);
});


test("reservas PIX expiradas e canceladas com data futura ficam no histórico", async () => {
  const f = fixture({
    reservations: [
      { agendamento_id: null, servico_id: "s1", data_servico: "2030-03-20", inicio_minuto: 780, estado: "reservada" },
      { agendamento_id: null, servico_id: "s1", data_servico: "2030-03-21", inicio_minuto: 780, estado: "confirmada" },
      { agendamento_id: null, servico_id: "s1", data_servico: "2030-03-22", inicio_minuto: 780, estado: "expirada" },
      { agendamento_id: null, servico_id: "s1", data_servico: "2030-03-23", inicio_minuto: 780, estado: "cancelada" },
    ],
  });
  const res = response();
  await atenderGestaoClientes(req("GET", `/admin/clientes/${CLIENT}`), res, f.pool, f.dependencies);
  assert.equal(res.status, 200);
  assert.equal(res.body.upcoming.some((item) => item.status === "Aguardando pagamento PIX"), true);
  assert.equal(res.body.upcoming.some((item) => item.status === "Reserva PIX confirmada"), true);
  assert.equal(res.body.upcoming.some((item) => item.status === "Reserva PIX expirada"), false);
  assert.equal(res.body.upcoming.some((item) => item.status === "Reserva PIX cancelada"), false);
  assert.equal(res.body.history.some((item) => item.status === "Reserva PIX expirada"), true);
  assert.equal(res.body.history.some((item) => item.status === "Reserva PIX cancelada"), true);
});
