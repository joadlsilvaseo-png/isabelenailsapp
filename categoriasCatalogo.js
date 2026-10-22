export function normalizarSlugCategoria(valor) {
  return String(valor || "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-");
}

export function categoriaAtiva(categoria) {
  return categoria?.ativo !== false && !["inativo", "inactive", "desativado", "disabled"].includes(String(categoria?.status || "ativo").toLowerCase());
}

export function nomeCategoriaDuplicado(categorias, nome, ignorarId = "") {
  const slug = normalizarSlugCategoria(nome);
  return (Array.isArray(categorias) ? categorias : []).some((categoria) =>
    categoria.id !== ignorarId && normalizarSlugCategoria(categoria.slug || categoria.nome) === slug,
  );
}

export function servicoAtivo(servico) {
  return servico?.ativo !== false && !["inativo", "desativado", "disabled"].includes(String(servico?.status || "").toLowerCase());
}

export function servicoPertenceCategoria(servico, categoria) {
  if (!servico || !categoria) return false;
  if (servico.categoriaId && servico.categoriaId === categoria.id) return true;
  const slugServico = normalizarSlugCategoria(servico.categoria || servico.categoriaSlug || servico.tipo);
  const slugCategoria = normalizarSlugCategoria(categoria.slug || categoria.nome);
  const aliases = Array.isArray(categoria.legacySlugs) ? categoria.legacySlugs.map(normalizarSlugCategoria) : [];
  return Boolean(slugServico && (slugServico === slugCategoria || aliases.includes(slugServico)));
}

export function categoriaPossuiServicos(categoria, servicos = []) {
  return Array.isArray(servicos) && servicos.some((servico) => servicoPertenceCategoria(servico, categoria));
}

export function montarCatalogoCliente(categorias = [], servicos = []) {
  return categorias.filter(categoriaAtiva).map((categoria) => ({
    ...categoria,
    servicos: servicos.filter((servico) => servicoAtivo(servico) && servicoPertenceCategoria(servico, categoria)),
  })).filter((categoria) => categoria.servicos.length > 0)
    .sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR"));
}
