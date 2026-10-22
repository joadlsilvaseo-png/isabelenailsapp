import test from "node:test";
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
