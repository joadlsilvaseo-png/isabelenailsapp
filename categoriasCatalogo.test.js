import test from "node:test";
import assert from "node:assert/strict";
import { categoriaPossuiServicos, montarCatalogoCliente, nomeCategoriaDuplicado, normalizarSlugCategoria, servicoPertenceCategoria } from "./categoriasCatalogo.js";

test("normaliza nomes para prevenir duplicidade independente de caixa e acentos", () => {
  assert.equal(normalizarSlugCategoria("  Unhas   em GEL "), "unhas-em-gel");
  assert.equal(normalizarSlugCategoria("Sobrancelhas"), "sobrancelhas");
});

test("detecta categoria duplicada normalizada e permite editar a própria categoria", () => {
  const categorias = [{ id: "a", nome: "Unhas em Gel", slug: "unhas-em-gel" }];
  assert.equal(nomeCategoriaDuplicado(categorias, "  UNHAS EM GÉL  "), true);
  assert.equal(nomeCategoriaDuplicado(categorias, "Unhas em Gel", "a"), false);
  assert.equal(nomeCategoriaDuplicado(categorias, "Pedicure"), false);
});

test("catálogo da cliente exibe apenas categorias ativas com serviços ativos", () => {
  const categorias = [
    { id: "gel", nome: "Unhas em Gel", slug: "unhas-em-gel", ativo: true },
    { id: "manicure", nome: "Manicure", slug: "manicure", ativo: true },
    { id: "off", nome: "Categoria desativada", slug: "off", ativo: false },
  ];
  const servicos = [
    { id: "s1", categoria: "unhas-em-gel", ativo: true },
    { id: "s2", categoriaId: "gel", ativo: false },
    { id: "s3", categoriaId: "off", ativo: true },
  ];
  assert.deepEqual(montarCatalogoCliente(categorias, servicos).map((item) => [item.id, item.servicos.map((s) => s.id)]), [["gel", ["s1"]]]);
});

test("a renomeação mantém serviços antigos ligados pelo slug legado e pelo ID", () => {
  const categoria = { id: "cat-original", nome: "Alongamentos", slug: "alongamentos", legacySlugs: ["unhas-em-gel"] };
  assert.equal(servicoPertenceCategoria({ categoria: "unhas-em-gel" }, categoria), true);
  assert.equal(servicoPertenceCategoria({ categoriaId: "cat-original" }, categoria), true);
  assert.equal(servicoPertenceCategoria({ categoria: "manicure" }, categoria), false);
});

test("a exclusão de uma categoria é bloqueada se um serviço estiver associado", () => {
  const categoria = { id: "cat", nome: "Cílios", slug: "cilios", legacySlugs: ["lashes"] };
  assert.equal(categoriaPossuiServicos(categoria, [{ categoria: "lashes" }]), true);
  assert.equal(categoriaPossuiServicos(categoria, [{ categoriaId: "cat" }]), true);
  assert.equal(categoriaPossuiServicos(categoria, [{ categoria: "manicure" }]), false);
});

test("categorias vazias ou com todos os serviços desativados não aparecem", () => {
  const catalogo = montarCatalogoCliente(
    [{ id: "empty", nome: "Vazia", slug: "vazia", ativo: true }],
    [{ id: "inactive", categoriaId: "empty", ativo: false }],
  );
  assert.deepEqual(catalogo, []);
});
