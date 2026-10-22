export function normalizarBusca(valor) {
  return String(valor || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
}

function variantesToken(token) {
  const variantes = new Set([token]);
  if (token.length > 4 && token.endsWith("oes")) variantes.add(`${token.slice(0, -3)}ao`);
  if (token.length > 4 && token.endsWith("aes")) variantes.add(`${token.slice(0, -3)}ao`);
  if (token.length > 4 && token.endsWith("ais")) variantes.add(`${token.slice(0, -3)}al`);
  if (token.length > 3 && token.endsWith("s")) variantes.add(token.slice(0, -1));
  if (token.length > 5 && token.endsWith("es")) variantes.add(token.slice(0, -2));
  return variantes;
}

export function correspondeBuscaCatalogo(item, consulta) {
  const query = normalizarBusca(consulta);
  if (!query) return false;
  const texto = normalizarBusca([
    item.nome,
    item.categoriaNome,
    item.descricao,
    item.categoriaDescricao,
    ...(Array.isArray(item.palavrasChave) ? item.palavrasChave : []),
  ].join(" "));
  if (texto.includes(query)) return true;
  const tokens = [...new Set(texto.split(" ").filter(Boolean))];
  return query.split(" ").filter(Boolean).every((termo) => {
    const variantes = variantesToken(termo);
    return tokens.some((token) => {
      const variantesDoToken = variantesToken(token);
      return [...variantes].some((variante) =>
        variantesDoToken.has(variante) || token.startsWith(variante),
      );
    });
  });
}

export function montarResultadosBusca(servicos, consulta) {
  const ids = new Set();
  return (Array.isArray(servicos) ? servicos : []).filter((servico) => {
    if (!servico?.id || ids.has(servico.id) || !correspondeBuscaCatalogo(servico, consulta)) return false;
    ids.add(servico.id);
    return true;
  });
}
