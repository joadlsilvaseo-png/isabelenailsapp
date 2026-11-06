function servicos(item) {
  return (item.servicosElegiveis || [])
    .map((servico) => `${servico.nome} (${servico.duracaoMinutos} min)`)
    .join(", ");
}

function resumoItem(item) {
  if (item.duracaoLacunaMinutos === 15) return "Lacuna de 15 min sem serviço ativo permitido; avalie se deseja manter aberta.";
  if (item.duracaoLacunaMinutos === 30 && item.contemServicoBaixaProcura) {
    return `Intervalo utilizável por serviço curto de baixa procura${servicos(item) ? `: ${servicos(item)}` : ""}; avalie se vale mantê-lo aberto.`;
  }
  if (item.duracaoLacunaMinutos === 30) return "Intervalo curto de 30 min para avaliação; nenhum horário foi alterado.";
  if (item.duracaoLacunaMinutos === 45 && item.contemServicoBaixaProcura) {
    return `A lacuna pode receber serviço curto de baixa procura${servicos(item) ? `: ${servicos(item)}` : ""}; avalie se vale mantê-la aberta.`;
  }
  if (item.duracaoLacunaMinutos === 45) return "Lacuna de 45 min sem serviço elegível; avalie se deseja fechá-la.";
  return "Nenhum serviço ativo permitido cabe nesta lacuna; avalie se deseja fechá-la.";
}

/** Resumo sem dados de clientes; recalculado pelo worker antes de cada envio. */
export function criarNotificacaoPreventiva(data, itens) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || "") || !Array.isArray(itens) || !itens.length) {
    throw new TypeError("Resumo de sugestão inválido");
  }
  const [ano, mes, dia] = data.split("-");
  const dataPt = `${dia}/${mes}/${ano}`;
  const mensagem = itens.length === 1
    ? `Sugestão para ${dataPt}: ${resumoItem(itens[0])} Confira a agenda atual.`
    : `${itens.length} intervalos para avaliar em ${dataPt}: ${itens.map(resumoItem).join(" ")}`;
  return {
    titulo: itens.length === 1 ? "Sugestão de Bloqueio" : "Sugestões de Agenda",
    mensagem: mensagem.slice(0, 1800),
  };
}
