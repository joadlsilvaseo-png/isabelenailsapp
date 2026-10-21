import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { montarPerfilClienteAuth, podeRecuperarPerfilCliente } from "../../../clientePerfilIntegridade.js";

const usuario = { uid: "cliente-exemplo", displayName: "Cliente Exemplo", email: "cliente@example.test", photoURL: null };

test("recupera somente clientes autenticadas sem documento", () => {
  assert.equal(podeRecuperarPerfilCliente(null, null), true);
  assert.equal(podeRecuperarPerfilCliente({ role: "cliente", ativo: true }, null), true);
  assert.equal(podeRecuperarPerfilCliente({ role: "admin", ativo: true }, null), false);
  assert.equal(podeRecuperarPerfilCliente({ role: "cliente", ativo: false }, null), false);
  assert.equal(podeRecuperarPerfilCliente({ role: "desconhecido", ativo: true }, null), false);
  assert.equal(podeRecuperarPerfilCliente(null, { nome: "Cliente existente" }), false);
});

test("perfil recuperado nao inventa telefone nem aceite de termos", () => {
  const p = montarPerfilClienteAuth(usuario, { agora: new Date("2026-10-21T15:00:00Z") });
  assert.equal(p.nome, "Cliente Exemplo");
  assert.equal(p.email, "cliente@example.test");
  assert.equal(p.telefone, "");
  assert.equal(p.role, "cliente");
  assert.equal(p.origemCadastro, "recuperacao-auth");
  assert.equal(p.dataCadastro, "2026-10-21T15:00:00.000Z");
  assert.equal("termosAceitos" in p, false);
  assert.equal("ativo" in p, false);
});

test("recuperacao usa somente dados explicitamente disponiveis", () => {
  const p = montarPerfilClienteAuth(
    { uid: "id", email: "exemplo@test.invalid", displayName: "", photoURL: "https://example.test/photo" },
    { nomeAlternativo: "Nome salvo", telefoneAlternativo: "11999990000" },
  );
  assert.equal(p.nome, "Nome salvo");
  assert.equal(p.telefone, "11999990000");
  assert.equal(p.foto, "https://example.test/photo");
  assert.equal(p.role, "cliente");
});

test("principal usa transacao condicional e cadastro Google nao ignora falhas", async () => {
  const [principal, registro, login] = await Promise.all([
    readFile(new URL("../../../principal.js", import.meta.url), "utf8"),
    readFile(new URL("../../../registro.js", import.meta.url), "utf8"),
    readFile(new URL("../../../login.js", import.meta.url), "utf8"),
  ]);
  assert.match(principal, /podeRecuperarPerfilCliente\(usuarioData, clienteData\)/);
  assert.match(principal, /runTransaction\(db, async \(transaction\) => \{[\s\S]*?if \(!atual\.exists\(\)\) transaction\.set\(clienteRef, perfilRecuperado\)/);
  assert.match(principal, /if \(!clienteRestaurado\.exists\(\)\)\s*\{/);
  assert.match(registro, /contaCriadaNoAuth = true/);
  assert.match(registro, /console\.error\("\[GOOGLE SIGNUP\] Erro ao gravar documento", setDocError\);\s*throw new Error/);
  assert.match(login, /console\.error\("\[GOOGLE LOGIN\] Erro ao criar documento", setDocError\);\s*throw new Error/);
});
