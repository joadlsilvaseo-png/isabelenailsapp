import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { servicoEhManutencao } from "../servicosOrientacao.mjs";
import assert from "node:assert/strict";
import { categoriaAtiva, categoriaPossuiServicos, montarCatalogoCliente, nomeCategoriaDuplicado, servicoPertenceCategoria } from "../categoriasCatalogo.mjs";
import { montarResultadosBusca } from "../catalogoBusca.mjs";

const categorias = [
  { id: "cat-manicure", nome: "Manicure", slug: "manicure", ativo: true, descricao: "Cuidados das mãos" },
  { id: "cat-lash", nome: "Cílios", slug: "cilios", ativo: true, descricao: "Alongamento e manutenção" },
  { id: "cat-inativa", nome: "Pedicure", slug: "pedicure", ativo: false },
];
const servicos = [
  { id: "svc-1", nome: "Alongamento em Fibra", categoriaId: "cat-lash", descricao: "Extensão de cílios", palavrasChave: ["lash", "volume"], ativo: true },
  { id: "svc-2", nome: "Esmaltação", categoria: "manicure", descricao: "Mãos", ativo: true },
  { id: "svc-3", nome: "Serviço antigo", categoria: "pedicure", ativo: true },
  { id: "svc-off", nome: "Fibra inativa", categoriaId: "cat-lash", ativo: false },
];

test("categorias podem ser identificadas, duplicidades bloqueadas e vínculos preservados por id ou slug", () => {
  assert.equal(categoriaAtiva(categorias[0]), true);
  assert.equal(categoriaAtiva(categorias[2]), false);
  assert.equal(nomeCategoriaDuplicado(categorias, "CILIOS"), true);
  assert.equal(nomeCategoriaDuplicado(categorias, "Nova categoria"), false);
  assert.equal(categoriaPossuiServicos(categorias[1], servicos), true);
  assert.equal(servicoPertenceCategoria(servicos[1], categorias[0]), true);
});

test("catálogo da cliente esconde categorias inativas e categorias sem serviço ativo", () => {
  const catalogo = montarCatalogoCliente(categorias, servicos);
  assert.deepEqual(catalogo.map((categoria) => categoria.id), ["cat-lash", "cat-manicure"]);
  assert.deepEqual(catalogo[0].servicos.map((servico) => servico.id), ["svc-1"]);
});

test("pesquisa dinâmica considera serviço, categoria, descrições, acentos, plural e sinônimos sem duplicar IDs", () => {
  const indexado = servicos.slice(0, 2).map((servico) => ({
    ...servico,
    categoriaNome: servico.id === "svc-1" ? "Cílios" : "Manicure",
    categoriaDescricao: servico.id === "svc-1" ? "Alongamento e manutenção" : "Cuidados das mãos",
  }));
  assert.deepEqual(montarResultadosBusca(indexado, "fibra").map((item) => item.id), ["svc-1"]);
  assert.deepEqual(montarResultadosBusca(indexado, "manutencoes").map((item) => item.id), ["svc-1"]);
  assert.deepEqual(montarResultadosBusca(indexado, "cilios").map((item) => item.id), ["svc-1"]);
  assert.deepEqual(montarResultadosBusca([...indexado, indexado[0]], "alongamento").map((item) => item.id), ["svc-1"]);
});

test("etiqueta de manutenção identifica nomes reais e ignora primeira aplicação", () => {
  assert.equal(servicoEhManutencao("Manutenção Banho de Gel"), true);
  assert.equal(servicoEhManutencao("Manutencao de Fibra de Vidro"), true);
  assert.equal(servicoEhManutencao("Banho de Gel"), false);
  assert.equal(servicoEhManutencao("Alongamento em Fibra de Vidro"), false);
});

test("todas as telas do catálogo compartilham a orientação antes do agendamento", async () => {
  const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const pagina of ["manicure.html", "pedicure.html", "unhas-em-gel.html", "categoria.html"]) {
    const html = await readFile(path.join(raiz, pagina), "utf8");
    assert.match(html, /servicos-orientacao\.css\?v=1\.0\.0/);
    assert.match(html, /Confira antes de agendar/);
    assert.match(html, /Manutenção é para quem já possui a aplicação/);
    assert.ok(html.indexOf("Confira antes de agendar") < html.indexOf("Continuar para agendamento"));
  }
  for (const js of ["manicure.js", "pedicure.js", "unhas-em-gel.js", "categoria.js"]) {
    const source = await readFile(path.join(raiz, js), "utf8");
    assert.match(source, /criarEtiquetaManutencao/);
    assert.match(source, /servicosOrientacao\.mjs\?v=1\.0\.0/);
  }
});
