import test from "node:test";
import assert from "node:assert/strict";
import { consultarDisponibilidadePix as consultarDisponibilidadePixOriginal } from "../src/pixDisponibilidadeApi.js";
// Fixar o relógio da fixture: novembro de 2026 não deve se tornar passado ao executar o CI.
const FIXTURE_AGORA = new Date("2026-11-04T15:00:00-03:00");
const consultarDisponibilidadePix = (req, res, pool, dependencias = {}) =>
  consultarDisponibilidadePixOriginal(req, res, pool, { now: FIXTURE_AGORA, ...dependencias });

function criarResposta() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function criarPool(reservas) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      const [data, agendamentoId, clienteUidExcluido, solicitanteUid] = params;
      const rows = reservas.filter((reserva) => reserva.data === data &&
        ["reservada", "confirmada"].includes(reserva.estado) &&
        (agendamentoId === null || reserva.agendamentoId !== agendamentoId || reserva.clienteUid !== clienteUidExcluido));
      return { rows: rows.map(({ inicio, fim, clienteUid, estado, agendamentoId: id }) => ({
        inicio_minuto: inicio, fim_minuto: fim,
        sequencial_mesma_cliente: agendamentoId === null && estado === "confirmada" &&
          clienteUid === solicitanteUid && Boolean(id),
      })) };
    },
  };
}

test("disponibilidade inclui reservas PIX pendentes, vencidas ainda reservadas e confirmadas", async () => {
  const pool = criarPool([
    { data: "2026-11-05", inicio: 810, fim: 930, estado: "reservada", venceEm: "2026-11-01", uid: "privado" },
    { data: "2026-11-05", inicio: 930, fim: 990, estado: "confirmada", uid: "privado" },
    { data: "2026-11-05", inicio: 990, fim: 1050, estado: "expirada", uid: "privado" },
    { data: "2026-11-06", inicio: 810, fim: 870, estado: "reservada", uid: "privado" },
  ]);
  const resposta = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05", headers: {} },
    resposta,
    pool,
    { verificarUsuario: async () => "cliente-1" },
  );

  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.body, { intervalos: [
    { inicioMinuto: 810, fimMinuto: 930, tipo: "reserva" },
    { inicioMinuto: 930, fimMinuto: 990, tipo: "reserva" },
  ] });
  assert.equal(JSON.stringify(resposta.body).includes("privado"), false);
  assert.equal(resposta.headers["Cache-Control"], "no-store");
  assert.match(pool.chamadas[0].sql, /estado IN \('reservada', 'confirmada'\)/);
  assert.equal(pool.chamadas[0].sql.trim().toLowerCase().startsWith("select"), true);
  assert.doesNotMatch(pool.chamadas[0].sql, /\b(insert|update|delete|upsert)\b/i);
  assert.match(pool.chamadas[0].sql, /FROM public\.agenda_bloqueios/);
});

test("consulta de disponibilidade é autenticada e valida a data", async () => {
  const pool = criarPool([]);
  const semAuth = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05", headers: {} },
    semAuth, pool, { verificarUsuario: async () => { throw new Error("invalid token"); } },
  );
  assert.equal(semAuth.status, 401);
  assert.equal(pool.chamadas.length, 0);

  const dataInvalida = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-02-30", headers: {} },
    dataInvalida, pool, { verificarUsuario: async () => "cliente-1" },
  );
  assert.equal(dataInvalida.status, 400);
  assert.equal(pool.chamadas.length, 0);
});

test("somente exclui reserva do próprio agendamento autorizado ao reagendar", async () => {
  const db = {
    collection(nome) {
      return { doc(id) {
        return { async get() {
          if (nome === "agendamentos" && id === "meu-agendamento") {
            return { exists: true, data: () => ({ clienteId: "cliente-1", status: "confirmado" }) };
          }
          return { exists: false, data: () => null };
        } };
      } };
    },
  };
  const pool = criarPool([
    { data: "2026-11-05", inicio: 810, fim: 870, estado: "confirmada", agendamentoId: "meu-agendamento", clienteUid: "cliente-1" },
    { data: "2026-11-05", inicio: 840, fim: 900, estado: "reservada", agendamentoId: "outro", clienteUid: "cliente-2" },
  ]);
  const resposta = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05&agendamentoId=meu-agendamento", headers: {} },
    resposta, pool,
    { verificarUsuario: async () => "cliente-1", firestore: db },
  );
  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.body.intervalos, [{ inicioMinuto: 840, fimMinuto: 900, tipo: "reserva" }]);
  assert.deepEqual(pool.chamadas[0].params, ["2026-11-05", "meu-agendamento", "cliente-1", "cliente-1"]);
});

test("admin autorizado exclui somente a reserva original da cliente no reagendamento", async () => {
  const db = {
    collection(nome) {
      return { doc(id) {
        return { async get() {
          if (nome === "agendamentos" && id === "agendamento-cliente") {
            return { exists: true, data: () => ({ clienteId: "cliente-proprietaria", status: "confirmado" }) };
          }
          if (nome === "usuarios" && id === "admin-1") {
            return { exists: true, data: () => ({ role: "admin", ativo: true }) };
          }
          return { exists: false, data: () => null };
        } };
      } };
    },
  };
  const pool = criarPool([
    { data: "2026-11-05", inicio: 810, fim: 870, estado: "confirmada", agendamentoId: "agendamento-cliente", clienteUid: "cliente-proprietaria" },
    { data: "2026-11-05", inicio: 840, fim: 900, estado: "reservada", agendamentoId: "agendamento-terceiro", clienteUid: "cliente-terceiro" },
  ]);
  const resposta = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05&agendamentoId=agendamento-cliente", headers: {} },
    resposta, pool,
    { verificarUsuario: async () => "admin-1", firestore: db },
  );

  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.body.intervalos, [{ inicioMinuto: 840, fimMinuto: 900, tipo: "reserva" }]);
  assert.deepEqual(pool.chamadas[0].params, ["2026-11-05", "agendamento-cliente", "cliente-proprietaria", "admin-1"]);
});

test("agendamento PIX que exige conciliação não pode ter sua reserva excluída", async () => {
  const db = {
    collection(nome) {
      return { doc() { return { async get() {
        if (nome === "agendamentos") {
          return { exists: true, data: () => ({ clienteId: "cliente-1", status: "confirmado", pixCobrancaId: "charge-1" }) };
        }
        return { exists: true, data: () => ({ role: "admin", ativo: true }) };
      } }; } };
    },
  };
  const pool = criarPool([
    { data: "2026-11-05", inicio: 810, fim: 870, estado: "reservada", agendamentoId: "agendamento-pix", clienteUid: "cliente-1" },
  ]);
  const resposta = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05&agendamentoId=agendamento-pix", headers: {} },
    resposta, pool,
    { verificarUsuario: async () => "admin-1", firestore: db },
  );

  assert.equal(resposta.status, 409);
  assert.equal(pool.chamadas.length, 0);
});

test("não permite ocultar a reserva de outra cliente ao consultar reagendamento", async () => {
  const db = {
    collection() {
      return { doc() { return { async get() {
        return { exists: true, data: () => ({ clienteId: "outra-cliente", status: "confirmado" }) };
      } }; } };
    },
  };
  const pool = criarPool([
    { data: "2026-11-05", inicio: 810, fim: 870, estado: "reservada", agendamentoId: "agendamento-alheio", clienteUid: "outra-cliente" },
  ]);
  const resposta = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05&agendamentoId=agendamento-alheio", headers: {} },
    resposta, pool,
    { verificarUsuario: async () => "cliente-1", firestore: db },
  );
  assert.equal(resposta.status, 403);
  assert.equal(pool.chamadas.length, 0);
});

test("falha de consulta retorna erro sem alterar o banco", async () => {
  const pool = {
    chamadas: [],
    async query(sql) { this.chamadas.push(sql); throw new Error("database offline"); },
  };
  const resposta = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-11-05", headers: {} },
    resposta, pool, { verificarUsuario: async () => "cliente-1" },
  );
  assert.equal(resposta.status, 503);
  assert.equal(pool.chamadas.length, 1);
  assert.equal(pool.chamadas[0].trim().toLowerCase().startsWith("select"), true);
});

test("consulta autenticada libera dezembro aberto e rejeita dia fechado sem consultar PostgreSQL", async () => {
  const pool = criarPool([]);
  const now = new Date("2026-11-04T15:00:00-03:00");
  const ativo = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-12-14", headers: {} },
    ativo, pool, { verificarUsuario: async () => "cliente-1", now },
  );
  assert.equal(ativo.status, 200);
  assert.deepEqual(ativo.body, { intervalos: [] });
  assert.equal(pool.chamadas.length, 1);
  const fechado = criarResposta();
  await consultarDisponibilidadePix(
    { method: "GET", url: "/pix/disponibilidade?data=2026-12-15", headers: {} },
    fechado, pool, { verificarUsuario: async () => "cliente-1", now },
  );
  assert.equal(fechado.status, 400);
  assert.equal(fechado.body.erro, "Dia sem atendimento");
  assert.equal(pool.chamadas.length, 1);
});

// A API nunca devolve o UID de clientes. A flag é calculada com o token verificado.
test("reserva confirmada da mesma cliente habilita somente a emenda de novo agendamento", async () => {
  const pool = criarPool([
    { data: "2026-11-05", inicio: 960, fim: 1020, estado: "confirmada",
      clienteUid: "cliente-1", agendamentoId: "pix-primeiro" },
    { data: "2026-11-05", inicio: 1050, fim: 1110, estado: "confirmada",
      clienteUid: "outra", agendamentoId: "pix-outra" },
    { data: "2026-11-05", inicio: 1140, fim: 1200, estado: "reservada",
      clienteUid: "cliente-1", agendamentoId: null },
  ]);
  const resposta = criarResposta();
  await consultarDisponibilidadePix({
    method: "GET", url: "/pix/disponibilidade?data=2026-11-05", headers: {},
  }, resposta, pool, { verificarUsuario: async () => "cliente-1" });
  assert.equal(resposta.status, 200);
  assert.equal(resposta.body.intervalos[0].sequencialMesmaCliente, true);
  assert.equal("sequencialMesmaCliente" in resposta.body.intervalos[1], false);
  assert.equal("sequencialMesmaCliente" in resposta.body.intervalos[2], false);
  assert.equal(JSON.stringify(resposta.body).includes("cliente-1"), false);
});
