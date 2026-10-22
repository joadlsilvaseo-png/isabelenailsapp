import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ler = (arquivo) => readFile(new URL(arquivo, import.meta.url), "utf8");

test("as regras permitem leitura do catálogo e limitam gravações de categorias a administradores", async () => {
  const rules = await ler("./firestore.rules");
  const bloco = rules.match(/match \/categorias\/\{categoriaId\} \{([\s\S]*?)\n    \}/)?.[1] || "";
  assert.match(bloco, /allow read:\s*if true/);
  assert.match(bloco, /allow create, update, delete:\s*if ehAdmin\(\)/);
});

test("a tela administrativa tem controles de categoria conectados ao Firestore", async () => {
  const html = await ler("./admin-servicos.html");
  const js = await ler("./admin-servicos.js");
  assert.match(html, /id="admin-manage-categories-button"/);
  assert.match(html, /id="admin-category-form"/);
  assert.match(html, /id="admin-categories-list"/);
  assert.match(js, /collection\(db, "categorias"\)/);
  assert.match(js, /nomeCategoriaDuplicado\(/);
  assert.match(js, /serviços vinculados/);
  assert.match(js, /categoriaId/);
});

test("a Principal consulta o catálogo ativo e envia o ID estável do serviço para agendar", async () => {
  const principal = await ler("./principal.js");
  assert.match(principal, /collection\(db, "categorias"\)/);
  assert.match(principal, /collection\(db, "servicos"\)/);
  assert.match(principal, /montarCatalogoCliente/);
  assert.match(principal, /agendamento\.html\?id=/);
});
