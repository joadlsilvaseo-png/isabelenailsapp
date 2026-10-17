import test from "node:test";
import assert from "node:assert/strict";
import { consultarDisponibilidadePix } from "../src/pixDisponibilidadeApi.js";

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
      const [data, agendamentoId, uid] = params;
      const rows = reservas.filter((reserva) => reserva.data === data &&
        ["reservada", "confirmada"].includes(reserva.estado) &&
        (agendamentoId === null || reserva.agendamentoId !== agendamentoId || reserva.clienteUid !== uid));
      return { rows: rows.map(({ inicio, fim }) => ({ inicio_minuto: inicio, fim_minuto: fim })) };
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
    { inicioMinuto: 810, fimMinuto: 930 },
    { inicioMinuto: 930, fimMinuto: 990 },
  ] });
  assert.equal(JSON.stringify(resposta.body).includes("privado"), false);
  assert.equal(resposta.headers["Cache-Control"], "no-store");
  assert.match(pool.chamadas[0].sql, /estado IN \('reservada', 'confirmada'\)/);
  assert.equal(pool.chamadas[0].sql.trim().toLowerCase().startsWith("select"), true);
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
  assert.deepEqual(resposta.body.intervalos, [{ inicioMinuto: 840, fimMinuto: 900 }]);
  assert.deepEqual(pool.chamadas[0].params, ["2026-11-05", "meu-agendamento", "cliente-1"]);
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
