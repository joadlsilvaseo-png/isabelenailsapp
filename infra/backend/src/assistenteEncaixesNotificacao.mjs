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
  if (itens.some((item) => item?.data !== data ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.inicio) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.fim))) {
    throw new TypeError("Horário inválido na sugestão preventiva");
  }
  const [ano, mes, dia] = data.split("-");
  const dataPt = `${dia}/${mes}/${ano}`;
  // O intervalo vem primeiro para aparecer inclusive na prévia curta do push.
  // Agrupamentos grandes exibem os primeiros horários e o total restante.
  const horarios = itens.slice(0, 5)
    .map((item) => `${item.inicio}–${item.fim}`).join(", ");
  const restantes = itens.length > 5 ? ` e mais ${itens.length - 5}` : "";
  const mensagem = itens.length === 1
    ? `Sugestão para ${dataPt}, das ${itens[0].inicio} às ${itens[0].fim}: ${resumoItem(itens[0])} Confira a agenda atual.`
    : `${itens.length} intervalos para avaliar em ${dataPt}: ${horarios}${restantes}. Consulte o Gerenciador de Calendário.`;
  return {
    titulo: itens.length === 1 ? "Sugestão de Bloqueio" : "Sugestões de Agenda",
    mensagem: mensagem.slice(0, 1800),
  };
}
