import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(path.join(root, file), "utf8");
const exists = async (file) => access(path.join(root, file)).then(() => true, () => false);
const required = [
  "principal.html", "principal.js", "principal.css", "admin-servicos.html", "admin-servicos.js",
  "manicure.html", "pedicure.html", "unhas-em-gel.html", "categoria.html", "categoria.js", "manicure.css",
  "agendamento.html", "agendamento.js", "agendamentoDisponibilidade.js", "infra/backend/src/agendamentoRegras.mjs",
  "infra/backend/src/pixDisponibilidade.js", "infra/backend/src/pixDisponibilidadeApi.js", "firestore.rules", "service-worker.js",
];
for (const file of required) assert.ok(await exists(file), `Arquivo obrigatório ausente: ${file}`);
const principal = await read("principal.html");
const principalJs = await read("principal.js");
const agenda = await read("agendamento.html");
const agendaJs = await read("agendamento.js");
const worker = await read("service-worker.js");
const rules = await read("firestore.rules");
for (const [file, selector] of [["manicure.html", "manicure-list"], ["pedicure.html", "pedicure-list"], ["unhas-em-gel.html", "unhas-list"]]) {
  const html = await read(file);
  assert.ok(html.includes(selector), `Página individual preservada: ${file}`);
  assert.match(html, /Continuar para agendamento/);
}
assert.match(await read("categoria.html"), /href="manicure\.css\?v=2\.0\.0"/);
assert.match(principal, /id="principal-search-results"/);
assert.match(principalJs, /montarCatalogoCliente/);
assert.match(principalJs, /agendamento\.html\?id=/);
assert.doesNotMatch(principalJs, /categorySearchTerms/);
assert.match(agenda, /class="agendamento-calendar"/);
assert.doesNotMatch(agenda, /calendar-previous-month|calendar-next-month/);
assert.match(agendaJs, /const janela = obterJanelaAgendamento\(\)/);
assert.match(agendaJs, /while \(cursor <= limite\)/);
assert.match(worker, /\.\/categoria\.html/);
assert.match(rules, /match \/categorias\/\{categoriaId\}[\s\S]*?allow create, update, delete: if ehAdmin\(\);/);
console.log(`Estrutura verificada: ${required.length} arquivos e fluxos essenciais.`);
