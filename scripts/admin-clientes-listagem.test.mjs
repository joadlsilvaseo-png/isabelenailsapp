import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { organizarClientes } from "../admin-clientes-listagem.mjs";

const clientes = [
  { id: "z", name: "Zélia" },
  { id: "j", name: "Joana" },
  { id: "a2", name: "ana Maria" },
  { id: "b", name: "Bruna" },
  { id: "a1", name: "Ána Maria" },
  { id: "c", name: "Cátia" },
];
const isencoes = new Set(["j", "a2", "c"]);

test("ordena nomes de todas as páginas por ordem alfabética brasileira", () => {
  assert.deepEqual(organizarClientes(clientes).map((x) => x.id),
    ["a1", "a2", "b", "c", "j", "z"]);
  assert.equal(clientes[0].id, "z"); // Não modifica a fonte.
});

test("filtra somente clientes com isenção ativa, ainda em ordem alfabética", () => {
  assert.deepEqual(organizarClientes(clientes, isencoes, true).map((x) => x.id),
    ["a2", "c", "j"]);
  assert.deepEqual(organizarClientes(clientes, isencoes, false).length, 6);
  assert.deepEqual(organizarClientes([], isencoes, true), []);
});

test("lista combina páginas de API antes de ordenar e preserva fluxo do perfil", async () => {
  const js = await readFile(new URL("../admin-clientes.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../admin-clientes.html", import.meta.url), "utf8");
  assert.match(js, /new URLSearchParams\(\{ limit: "50" \}\)/);
  assert.match(js, /while \(true\)/);
  assert.match(js, /if \(!resultado\.hasMore\) break/);
  assert.match(js, /organizarClientes\(clientesCarregadas, isencoesAtivas/);
  assert.match(js, /salvarIsencaoComReversao\(/);
  assert.match(js, /apiFetch\("\/api\/admin\/isencoes-sinal-pix"/);
  assert.match(html, /data-pix-filter="isentas"/);
  assert.match(html, /data-pix-filter="todos"/);
});
