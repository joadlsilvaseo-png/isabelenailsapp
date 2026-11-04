import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = new URL("../", import.meta.url);
const [html, js, css, sw] = await Promise.all([
  readFile(new URL("admin-agendamentos.html", base), "utf8"),
  readFile(new URL("admin-agendamentos.js", base), "utf8"),
  readFile(new URL("admin-agendamentos.css", base), "utf8"),
  readFile(new URL("service-worker.js", base), "utf8"),
]);

test("somente o grupo técnico confirmado/reagendado aparece como Agendados na interface", () => {
  assert.doesNotMatch(html, /data-status-filter="agendados"/);
  assert.doesNotMatch(html, /data-summary-filter="agendados"/);
  assert.match(html, /data-status-filter="confirmados"[\s\S]{0,130}Agendados/);
  assert.match(html, /data-summary-filter="confirmados"[\s\S]{0,800}Agendados/);
  assert.match(js, /statusNormalizado === "confirmado"[\s\S]*?statusNormalizado === "reagendado"[\s\S]*?return "confirmados"/);
  assert.match(js, /confirmado: "Agendado"/);
  assert.match(js, /confirmado: "confirmar_admin"/);
  assert.match(js, /status: "confirmado"/);
  assert.doesNotMatch(html, /admin-total-pendentes/);
});

test("foto personalizada autenticada precede foto HTTPS, com iniciais como fallback", () => {
  assert.match(js, /function exibirAvatarClienteNoModal/);
  assert.match(js, /async function carregarFotoDoPerfilNoModal/);
  assert.match(js, /encodeURIComponent\(uid\) \+ "\/foto"/);
  assert.match(js, /getIdToken\(\)/);
  assert.match(js, /formato !== "image\/webp"/);
  assert.match(js, /avatar\.textContent = obterIniciais\(obterNomeCliente\(agendamento\)\)/);
  assert.match(js, /fotoExterna = obterFotoCliente\(agendamento\)/);
  assert.match(js, /!fotoModalAgendamentoUrl/);
  assert.match(js, /URL\.revokeObjectURL\(fotoModalAgendamentoUrl\)/);
  assert.match(js, /versao === versaoFotoModalAgendamento/);
  assert.match(js, /exibirAvatarClienteNoModal\(/);
  assert.match(css, /\.admin-modal-client \.admin-modal-client-avatar/);
  assert.match(css, /font-size: 15px/);
});

test("cache PWA e JS/CSS foram atualizados", () => {
  assert.match(html, /admin-agendamentos\.js\?v=1\.0\.2/);
  assert.match(html, /admin-agendamentos\.css\?v=1\.0\.4/);
  assert.match(sw, /CACHE_VERSION = "v\d+"/);
  assert.match(sw, /\.\/admin-agendamentos\.js/);
  assert.match(sw, /\.\/admin-agendamentos\.css/);
});
