import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const root = new URL("../", import.meta.url);
const [principal, html] = await Promise.all([
  readFile(new URL("principal.js", root), "utf8"),
  readFile(new URL("principal.html", root), "utf8"),
]);

test("módulos secundários não entram na cadeia estática de principal.js", () => {
  for (const modulo of [
    "notificationService.js",
    "centralNotificacoesUI.js",
    "foto-perfil-api.js",
    "assistenteGestaoUI.js",
    "categoriasCatalogo.mjs",
    "catalogoBusca.mjs",
  ]) {
    assert.doesNotMatch(principal, new RegExp(`^import[\\s\\S]*?from [\\\"']\\./${modulo.replaceAll(".", "\\.")}`, "m"));
  }
  assert.doesNotMatch(html, /<script[^>]+foto-perfil-preview\.js/);
});

test("acesso administrativo continua bloqueado até validação do perfil no Firestore", () => {
  const inicio = principal.indexOf("async function handleAuthenticatedUser(");
  const fim = principal.indexOf("\nfunction initPrincipalPage()", inicio);
  const fluxo = principal.slice(inicio, fim);
  const validar = fluxo.indexOf("const accessProfile = await loadUserAccessProfile(user)");
  const negar = fluxo.indexOf("if (!accessProfile.allowed)");
  const liberar = fluxo.indexOf("configureAdminInterface(user, accessProfile, elements)");
  const carregarAssistente = fluxo.indexOf('import("./assistenteGestaoUI.js?v=3")');

  assert.ok(validar >= 0 && negar > validar);
  assert.ok(liberar > negar);
  assert.ok(carregarAssistente > negar);
  assert.match(fluxo.slice(negar, liberar), /await signOut\(auth\)/);
  assert.match(principal, /if \(usuarioData\.ativo !== true\)/);
  assert.match(principal, /if \(role !== "admin" && role !== "cliente"\)/);
});

test("marcas de desempenho são genéricas e separam auth, perfil, UI e recursos secundários", () => {
  for (const marca of [
    "auth-wait-start",
    "auth-callback",
    "profile-read-start",
    "profile-read-ready",
    "ui-released",
    "assistant-module-start",
    "notifications-module-start",
    "profile-photo-start",
    "push-module-start",
  ]) {
    assert.ok(principal.includes(`principal:${marca}`) || principal.includes(`"${marca}"`), `marca ausente: ${marca}`);
  }
  assert.doesNotMatch(principal, /marcarEtapaPrincipal\([^)]*(?:uid|email|token)/i);
  assert.doesNotMatch(principal, /medirEtapaPrincipal\([^)]*(?:uid|email|token)/i);
});

test("catálogo e busca carregam apenas no caminho de cliente e em paralelo às consultas existentes", () => {
  const inicio = principal.indexOf("async function carregarCatalogoCliente()");
  const fim = principal.indexOf("\nfunction setupPrincipalSearch()", inicio);
  const carga = principal.slice(inicio, fim);

  assert.match(carga, /Promise\.all\(\[[\s\S]*import\("\.\/categoriasCatalogo\.mjs"\)[\s\S]*import\("\.\/catalogoBusca\.mjs"\)[\s\S]*getDocs\(collection\(db, "categorias"\)\)[\s\S]*getDocs\(collection\(db, "servicos"\)\)/);
  assert.match(principal, /configureClientInterface\(user, accessProfile, elements\)/);
  assert.match(principal, /void carregarCatalogoCliente\(\)/);
});

test("busca não mostra resultado vazio durante a carga e reaplica a consulta atual ao concluir", () => {
  const inicio = principal.indexOf("function setupPrincipalSearch()");
  const fim = principal.indexOf("/* ============================================================\n   ELEMENTOS DA PÁGINA", inicio);
  const busca = principal.slice(inicio, fim);
  const guarda = busca.indexOf("if (!gateBuscaCatalogo.estaPronto())");
  const resultados = busca.indexOf("montarResultadosBuscaCliente(catalogoServicosCliente, query)");

  assert.ok(guarda >= 0 && resultados > guarda);
  assert.match(busca, /gateBuscaCatalogo\.agendar\(\(\) => renderResults\(searchInput\.value\)\)/);
  assert.match(principal, /gateBuscaCatalogo\.finalizar\(\)/);
  assert.doesNotMatch(principal, /montarResultadosBuscaCliente = \(\) => \[\]/);
});

test("fila da busca preserva consultas durante o carregamento e atualiza a consulta mais recente", () => {
  const inicio = principal.indexOf("function criarGateBuscaProgressiva()");
  const fim = principal.indexOf("\n\nconst gateBuscaCatalogo", inicio);
  assert.ok(inicio >= 0 && fim > inicio);
  const gate = runInNewContext(`${principal.slice(inicio, fim)}\ncriarGateBuscaProgressiva()`);
  const renderizados = [];
  let textoAtual = "fibra";

  gate.agendar(() => renderizados.push(textoAtual));
  assert.deepEqual(renderizados, []); // antes e durante: não produz falso “nenhum serviço”.

  textoAtual = "banho de gel";
  gate.agendar(() => renderizados.push(textoAtual));
  assert.deepEqual(renderizados, []);

  gate.finalizar();
  assert.deepEqual(renderizados, ["banho de gel"]); // ao concluir, usa o texto atual.

  textoAtual = "manicure";
  gate.agendar(() => renderizados.push(textoAtual));
  assert.deepEqual(renderizados, ["banho de gel", "manicure"]); // depois: executa na hora.
});

test("botão Editar foto só habilita após a importação instalar seus handlers", () => {
  const inicio = principal.indexOf('const botaoEditarFoto = document.getElementById("editar-foto-perfil")');
  const fim = principal.indexOf('if (accessProfile.role === "admin")', inicio);
  const fluxo = principal.slice(inicio, fim);
  const desabilitar = fluxo.indexOf("botaoEditarFoto.disabled = true");
  const importar = fluxo.indexOf('import("./foto-perfil-preview.js?v=2")');
  const habilitar = fluxo.indexOf("botaoEditarFoto.disabled = false");

  assert.ok(desabilitar >= 0 && importar > desabilitar && habilitar > importar);
  assert.match(fluxo.slice(importar), /\.then\(\(\) => \{[\s\S]*?botaoEditarFoto\.disabled = false/);
  assert.match(fluxo, /botaoEditarFoto\.setAttribute\("aria-disabled", "true"\)/);
  assert.match(fluxo, /botaoEditarFoto\.setAttribute\("aria-disabled", "false"\)/);
});
