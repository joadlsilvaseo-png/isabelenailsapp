import { validarDataNaJanela, validarHorarioEspecial, obterExpedienteEspecialDezembro2026, PASSO_GRADE_AGENDAMENTO_MINUTOS } from "./agendamentoRegras.mjs";
import { atendimentosConflitamComBuffer, indisponivelComBuffer } from "./agendaBuffer.mjs";
function horarioInvalido(motivo) {
  return { valido: false, motivo };
}

export function validarHorarioPix(dataIso, horario, duracao, agora = new Date(), opcoes = {}) {
  if (
    typeof dataIso !== "string" ||
    typeof horario !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dataIso) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)
  ) {
    return horarioInvalido("Data ou horario invalido");
  }

  const [ano, mes, dia] = dataIso.split("-").map(Number);

  if (ano < 2000 || ano > 2100) {
    return horarioInvalido("Data invalida");
  }

  const data = new Date(Date.UTC(ano, mes - 1, dia, 12));

  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) {
    return horarioInvalido("Data inexistente");
  }

  const validacaoData = validarDataNaJanela(dataIso, agora);
  if (!validacaoData.valido) return horarioInvalido(validacaoData.motivo);

  if (!Number.isSafeInteger(duracao) || duracao <= 0 || duracao > 600) {
    return horarioInvalido("Duracao invalida");
  }

  const [horas, minutos] = horario.split(":").map(Number);

  const inicio = horas * 60 + minutos;
  const fim = inicio + duracao;
  // Todos os inícios válidos pertencem à mesma grade de 15 minutos.
  // A ocupação é revalidada sob lock nos fluxos de PIX e reagendamento.
  const gradeValida = inicio % PASSO_GRADE_AGENDAMENTO_MINUTOS === 0;
  const diaSemana = data.getUTCDay();

  const especial = obterExpedienteEspecialDezembro2026(dataIso);
  // Datas fechadas permanecem indisponíveis, inclusive domingos e feriados.
  if (especial && !especial.aberto) return horarioInvalido("Dia sem atendimento");
  if (!especial && (diaSemana === 0 || diaSemana === 1)) {
    return horarioInvalido("Dia sem atendimento");
  }

  const horarioEstendido = diaSemana === 4 || diaSemana === 5;
  const sabado = diaSemana === 6;
  const abertura = especial?.inicioMinuto ?? (diaSemana === 4 ? 660 : 540);
  // Encerramento é a hora final do serviço, não seu último horário de início.
  const fechamento = especial?.encerramentoMinuto
    ?? (sabado ? 1110 : horarioEstendido ? 1260 : 1200);
  const ultimoInicio = fechamento - 30; // Duração mínima comercial de 30 min.
  if (inicio < abertura || inicio > ultimoInicio || !gradeValida || fim > fechamento) {
    return horarioInvalido("Fora do horario permitido");
  }

  // Sem pausa fixa: intervalos manuais, reservas e agendamentos são
  // revalidados pelas rotas de disponibilidade e confirmação.

  if (!validarHorarioEspecial(dataIso, horario, duracao)) {
    return horarioInvalido("Horário fora da janela de atendimento da data");
  }

  // Opção de compatibilidade de testes e pré-validação: nunca criar
  // privilégio especial para :15/:45. Bloqueios são literais; reservas
  // e atendimentos exigem 15 min antes/depois.
  if (Array.isArray(opcoes.intervalosEncaixe) &&
      indisponivelComBuffer(inicio, fim, opcoes.intervalosEncaixe)) {
    return horarioInvalido("Horário indisponível ou sem intervalo de segurança");
  }
  return { valido: true, inicioMinuto: inicio, fimMinuto: fim, encaixeInteligente: false };
}

export function possuiSobreposicao(inicio, fim, intervalos, buffer = 0) {
  if (!Array.isArray(intervalos)) {
    throw new TypeError("Lista de intervalos invalida");
  }

  return intervalos.some(
    (ocupado) => atendimentosConflitamComBuffer(
      inicio, fim, ocupado.inicioMinuto, ocupado.fimMinuto, buffer,
    ),
  );
}

