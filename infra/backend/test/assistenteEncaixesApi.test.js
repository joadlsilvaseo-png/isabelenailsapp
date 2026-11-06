import assert from "node:assert/strict";
import { atenderAssistenteEncaixes } from "../src/assistenteEncaixes.js";

const agora = new Date("2026-11-06T12:00:00Z");
function resposta() {
  return { status: 0, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(s) { this.body = JSON.parse(s); } };
}
function database(role = "admin", ativo = true) {
  return { collection(nome) {
    assert.equal(nome, "usuarios");
    return { doc(uid) {
      assert.equal(uid, "admin-1");
      return { get: async () => ({ exists: true, data: () => ({ role, ativo }) }) };
    } };
  } };
}
const dados = [{
  chave: "2026-12-10:720:810", data: "2026-12-10", inicio: "12:00",
  fim: "13:30", duracaoLacunaMinutos: 90, opcoes: [],
}];
const deps = { agora, db: database(), verificarUsuario: async () => "admin-1",
  consultarMes: async () => dados };
const pool = {};

const ok = resposta();
await atenderAssistenteEncaixes({
  method: "GET", url: "/admin/assistente/encaixes?mes=2026-12",
}, ok, pool, deps);
assert.equal(ok.status, 200);
assert.equal(ok.body.total, 1);
assert.equal(ok.headers["Cache-Control"], "private, no-store");

const porDia = resposta();
await atenderAssistenteEncaixes({
  method: "GET", url: "/admin/assistente/encaixes?mes=2026-12&data=2026-12-09",
}, porDia, pool, deps);
assert.equal(porDia.body.total, 0);

const cliente = resposta();
await atenderAssistenteEncaixes({
  method: "GET", url: "/admin/assistente/encaixes?mes=2026-12",
}, cliente, pool, { ...deps, db: database("cliente") });
assert.equal(cliente.status, 403);

const anonimo = resposta();
await atenderAssistenteEncaixes({
  method: "GET", url: "/admin/assistente/encaixes?mes=2026-12",
}, anonimo, pool, { ...deps, verificarUsuario: async () => { throw new Error("token inválido"); } });
assert.equal(anonimo.status, 401);

const metodo = resposta();
await atenderAssistenteEncaixes({
  method: "POST", url: "/admin/assistente/encaixes?mes=2026-12",
}, metodo, pool, deps);
assert.equal(metodo.status, 405);

const periodo = resposta();
await atenderAssistenteEncaixes({
  method: "GET", url: "/admin/assistente/encaixes?mes=2027-04",
}, periodo, pool, deps);
assert.equal(periodo.status, 400);
console.log("Assistente: autenticação, autorização e somente leitura validados");
