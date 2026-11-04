import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raiz = new URL("../", import.meta.url);
const [html, css, js] = await Promise.all([
  readFile(new URL("admin-agendamentos.html", raiz), "utf8"),
  readFile(new URL("admin-agendamentos.css", raiz), "utf8"),
  readFile(new URL("admin-agendamentos.js", raiz), "utf8"),
]);

test("modal de conclusão possui campo acessível e ações no padrão visual", () => {
  for (const id of [
    "admin-conclusao-modal", "admin-conclusao-form", "admin-conclusao-valor",
    "admin-conclusao-voltar", "admin-conclusao-confirmar", "admin-conclusao-erro",
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
    assert.match(js, new RegExp('"' + id + '"'));
  }
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /inputmode="decimal"/);
  assert.match(css, /\.admin-conclusao-modal/);
  assert.match(css, /#admin-conclusao-valor/);
});

test("conclusão usa modal próprio sem prompts e preserva ação existente na API", () => {
  const inicio = js.indexOf("function solicitarValorConclusaoAdmin(");
  const fim = js.indexOf("/* ============================================================\n   MODAL PERSONALIZADO — CANCELAMENTO ADMIN", inicio);
  assert.ok(inicio >= 0 && fim > inicio);
  const fluxo = js.slice(inicio, fim);
  assert.doesNotMatch(fluxo, /window\.(?:prompt|confirm|alert)\s*\(/);
  assert.match(fluxo, /await solicitarValorConclusaoAdmin\(agendamento\)/);
  assert.match(fluxo, /await atualizarAgendamento\(agendamento.id/);
  assert.match(fluxo, /status: "concluido"/);
  assert.match(fluxo, /valorFinal,/);
  assert.match(fluxo, /exibirModalCancelamentoAdmin/);
  assert.match(fluxo, /event\.key === "Escape"/);
  assert.match(fluxo, /event\.key !== "Tab"/);
  assert.match(fluxo, /Number\.isSafeInteger\(centavos\)/);
});
