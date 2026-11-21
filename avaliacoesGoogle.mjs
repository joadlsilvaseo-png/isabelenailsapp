/**
 * Regra de elegibilidade de avaliações: somente contas com pelo menos
 * um atendimento concluído, inclusive registros legados.
 */
export function ehAtendimentoConcluido(registro) {
  const status = String(registro?.status ?? "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return status === "concluido" || status === "realizado";
}

export function clienteTemAtendimentoConcluido(registros, uid) {
  const clienteUid = String(uid ?? "").trim();
  if (!clienteUid || !Array.isArray(registros)) return false;
  return registros.some((registro) => {
    const dados = typeof registro?.data === "function" ? registro.data() : registro;
    const dono = dados?.clienteId || dados?.idCliente;
    return String(dono ?? "").trim() === clienteUid && ehAtendimentoConcluido(dados);
  });
}
