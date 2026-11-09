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

test("principal recupera somente perfis elegiveis e cadastro Google propaga falhas", async () => {
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

  const inicioLogin = login.indexOf("async function redirectByRole(user)");
  const fimLogin = login.indexOf("\n/**\n * Log de eventos", inicioLogin);
  assert.ok(inicioLogin >= 0 && fimLogin > inicioLogin);
  const fluxoLogin = login.slice(inicioLogin, fimLogin);

  assert.match(fluxoLogin, /if \(entrouComGoogle && !ehAdmin\) \{[\s\S]*?if \(!celularBrasileiroValido\(telefoneAtual\)\)/);
  assert.match(fluxoLogin, /telefoneAtual = perfil\.exists\(\)[\s\S]*?telefone \|\|[\s\S]*?celular \|\|[\s\S]*?whatsapp \|\|[\s\S]*?phone/);
});

test("login Google mantém cliente com celular e exige salvar celular antes do acesso", async () => {
  const login = await readFile(new URL("../../../login.js", import.meta.url), "utf8");
  const inicio = login.indexOf("async function redirectByRole(user)");
  const fim = login.indexOf("\n/**\n * Log de eventos", inicio);
  const fluxoLogin = login.slice(inicio, fim);
  const fluxoSucesso = fluxoLogin.slice(0, fluxoLogin.indexOf("} catch (error) {"));

  assert.match(fluxoSucesso, /if \(!celularBrasileiroValido\(telefoneAtual\)\) \{\s*const telefone = await solicitarCelularGoogle\(\);/);
  assert.match(fluxoSucesso, /if \(perfil\.exists\(\)\) \{[\s\S]*?await setDoc\(userRef, \{ telefone \}, \{ merge: true \}\);/);
  assert.match(fluxoSucesso, /else \{\s*await setDoc\(userRef, \{[\s\S]*?telefone,[\s\S]*?role: "cliente"/);

  const ultimaGravacao = fluxoSucesso.lastIndexOf("await setDoc(userRef");
  const redirecionamentoCliente = fluxoSucesso.lastIndexOf('window.location.replace("principal.html")');
  assert.ok(ultimaGravacao >= 0 && redirecionamentoCliente > ultimaGravacao);
});

test("cancelar ou falhar a gravacao do perfil Google encerra a sessao sem liberar acesso", async () => {
  const login = await readFile(new URL("../../../login.js", import.meta.url), "utf8");
  const inicio = login.indexOf("async function redirectByRole(user)");
  const fim = login.indexOf("\n/**\n * Log de eventos", inicio);
  const fluxoLogin = login.slice(inicio, fim);

  assert.match(fluxoLogin, /if \(!telefone\) \{[\s\S]*?await signOut\(auth\);\s*return;\s*\}/);

  const inicioCatch = fluxoLogin.indexOf("} catch (error) {");
  const fimCatch = fluxoLogin.indexOf("} finally {", inicioCatch);
  const tratamentoErro = fluxoLogin.slice(inicioCatch, fimCatch);
  const inicioErroGoogle = tratamentoErro.indexOf("if (entrouComGoogle) {");
  const fallbackEmail = tratamentoErro.indexOf("} else {", inicioErroGoogle);
  assert.ok(inicioCatch >= 0 && fimCatch > inicioCatch && inicioErroGoogle > 0 && fallbackEmail > inicioErroGoogle);

  const erroGoogle = tratamentoErro.slice(inicioErroGoogle, fallbackEmail);
  const fallbackSenha = tratamentoErro.slice(fallbackEmail);
  assert.match(erroGoogle, /showError\([\s\S]*?Não foi possível concluir o cadastro/);
  assert.match(erroGoogle, /await signOut\(auth\)\.catch/);
  assert.doesNotMatch(erroGoogle, /window\.location\.replace/);
  assert.match(fallbackSenha, /window\.location\.replace\("principal\.html"\)/);
});
