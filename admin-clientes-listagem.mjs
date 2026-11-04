const comparador = new Intl.Collator("pt-BR", {
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
});

/**
 * Organiza todos os resultados obtidos da API, antes de paginar a exibição.
 * IDs não entram no critério principal de ordenação: apenas desempate estável.
 */
export function organizarClientes(clientes, isencoes = new Set(), somenteIsentas = false) {
  if (!Array.isArray(clientes)) return [];

  const autorizados = isencoes instanceof Set ? isencoes : new Set(isencoes || []);

  return clientes
    .filter((cliente) => cliente && typeof cliente.id === "string" &&
      (!somenteIsentas || autorizados.has(cliente.id)))
    .sort((a, b) =>
      comparador.compare(String(a.name || "").trim(), String(b.name || "").trim()) ||
      comparador.compare(a.id, b.id));
}
