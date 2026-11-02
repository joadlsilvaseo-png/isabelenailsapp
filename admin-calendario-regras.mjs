import { validarHorarioEspecial, obterExpedienteEspecialDezembro2026 } from "./infra/backend/src/agendamentoRegras.mjs";
import { obterLimitesAtendimentoSemanal } from "./agendamentoDisponibilidade.js";

/**
 * Orientação visual da grade administrativa, não uma verificação de vagas.
 * A grade reúne intervalos de 30 min; um intervalo sem início válido ainda
 * pode ser ocupado pelo restante de um atendimento já iniciado.
 * Não interfere nas permissões de fechar/reabrir ou nas regras do backend.
 */
export function obterRegraVisualDoIntervalo(dataIso, inicioMinuto) {
  if (typeof dataIso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dataIso)
      || !Number.isInteger(inicioMinuto) || inicioMinuto < 0 || inicioMinuto >= 1440
      || inicioMinuto % 30 !== 0) {
    return { tipo: "sem-inicio", detalhe: "Intervalo inválido para início de atendimento." };
  }

  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia, 12));
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1
      || data.getUTCDate() !== dia) {
    return { tipo: "sem-inicio", detalhe: "Data inválida para início de atendimento." };
  }

  const diaSemana = data.getUTCDay();
  const especial = obterExpedienteEspecialDezembro2026(dataIso);
  if (especial && !especial.aberto || !especial && (diaSemana === 0 || diaSemana === 1)) {
    return { tipo: "sem-inicio", detalhe: "Dia sem atendimento ao público." };
  }

  const limites = obterLimitesAtendimentoSemanal(diaSemana);
  const minAbertura = especial?.inicioMinuto ?? limites.minAbertura;
  const minFechamento = especial?.encerramentoMinuto ?? limites.minFechamento;
  const minUltimoInicio = especial ? minFechamento - 30 : limites.minUltimoInicio;
  const maxDuracao = Math.min(600, minFechamento - inicioMinuto);
  if (inicioMinuto < minAbertura || inicioMinuto > minUltimoInicio || maxDuracao < 1) {
    return {
      tipo: "sem-inicio",
      detalhe: "O sistema não permite iniciar um novo atendimento neste intervalo. Ele pode ser fechado manualmente.",
    };
  }

  // O cadastro admite durações em minutos, inclusive serviços não múltiplos de 30.
  // Por isso percorremos os minutos permitidos, em vez de presumir durações do catálogo.
  const duracoes = [];
  for (let duracao = 1; duracao <= maxDuracao; duracao++) {
    const hora = `${String(Math.floor(inicioMinuto / 60)).padStart(2, "0")}:${String(inicioMinuto % 60).padStart(2, "0")}`;
    if (validarHorarioEspecial(dataIso, hora, duracao)) {
      duracoes.push(duracao);
    }
  }

  if (!duracoes.length) {
    return {
      tipo: "sem-inicio",
      detalhe: "O sistema não permite iniciar um novo atendimento neste intervalo. Ele ainda pode fazer parte de um serviço mais longo e pode ser fechado manualmente.",
    };
  }

  const maximo = duracoes.at(-1);
  const faixaContinua = duracoes.length === maximo
    && duracoes.every((duracao, indice) => duracao === indice + 1);
  const descricaoDuracoes = faixaContinua
    ? `Duração máxima de ${maximo} min`
    : `Durações permitidas: ${duracoes.join(", ")} min`;

  // Na terça/quarta há inícios e durações definidos especificamente.
  // No sábado, as exceções começam às 15h. No fim do expediente,
  // o início pode aceitar somente atendimentos mais curtos.
  const inicioCondicionado = (!especial && (diaSemana === 2 || diaSemana === 3
    || (diaSemana === 6 && inicioMinuto >= 900))) || maximo < 120;

  if (inicioCondicionado) {
    return {
      tipo: "inicio-limitado",
      detalhe: `Início permitido com regras de duração. ${descricaoDuracoes}. Bloqueios manuais continuam disponíveis.`,
      duracoesPermitidas: duracoes,
    };
  }

  return {
    tipo: "livre",
    detalhe: `Início previsto pelo expediente. ${descricaoDuracoes}. A disponibilidade depende também das reservas e dos bloqueios.`,
    duracoesPermitidas: duracoes,
  };
}
