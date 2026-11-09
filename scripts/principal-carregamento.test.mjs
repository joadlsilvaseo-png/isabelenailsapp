import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
