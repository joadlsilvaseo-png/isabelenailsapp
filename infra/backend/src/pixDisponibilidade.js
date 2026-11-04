import { validarDataNaJanela, validarHorarioEspecial, obterExpedienteEspecialDezembro2026 } from "./agendamentoRegras.mjs";
function horarioInvalido(motivo) {
  return { valido: false, motivo };
}

export function validarHorarioPix(dataIso, horario, duracao, agora = new Date()) {
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
  const ultimoInicio = especial ? fechamento - 30
    : sabado ? 1020 : horarioEstendido ? 1230 : 1080;
  if (inicio < abertura || inicio > ultimoInicio || inicio % 30 !== 0 || fim > fechamento) {
    return horarioInvalido("Fora do horario permitido");
  }

  // Sem pausa fixa: intervalos manuais, reservas e agendamentos são
  // revalidados pelas rotas de disponibilidade e confirmação.

  if (!validarHorarioEspecial(dataIso, horario, duracao)) {
    return horarioInvalido(
      diaSemana === 2 ? "Horario indisponivel na terca"
        : diaSemana === 3 ? "Horario indisponivel na quarta"
        : "Horario ou duracao indisponivel no sabado"
    );
  }

  return {
    valido: true,
    inicioMinuto: inicio,
    fimMinuto: fim,
  };
}

export function possuiSobreposicao(inicio, fim, intervalos) {
  if (!Array.isArray(intervalos)) {
    throw new TypeError("Lista de intervalos invalida");
  }

  return intervalos.some(
    (ocupado) => inicio < ocupado.fimMinuto && fim > ocupado.inicioMinuto,
  );
}

