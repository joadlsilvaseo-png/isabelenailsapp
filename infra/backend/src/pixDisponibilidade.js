const DATAS_DEZEMBRO_LIBERADAS = new Set([]);

function horarioInvalido(motivo) {
  return { valido: false, motivo };
}

export function validarHorarioPix(dataIso, horario, duracao) {
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

  // Abertura oficial dos agendamentos: novembro de 2026.
  if (dataIso < "2026-11-01") {
    return horarioInvalido("Agenda disponível somente a partir de 01/11/2026");
  }

  // Dezembro de 2026 permanece fechado até liberação manual.
  if (ano === 2026 && mes === 12 && !DATAS_DEZEMBRO_LIBERADAS.has(dataIso)) {
    return horarioInvalido("Agenda de dezembro ainda não disponível");
  }

  if (!Number.isSafeInteger(duracao) || duracao <= 0 || duracao > 600) {
    return horarioInvalido("Duracao invalida");
  }

  const [horas, minutos] = horario.split(":").map(Number);

  const inicio = horas * 60 + minutos;
  const fim = inicio + duracao;
  const diaSemana = data.getUTCDay();

  // Atendimento permitido somente de terça a sábado.
  if (diaSemana === 0 || diaSemana === 1) {
    return horarioInvalido("Dia sem atendimento");
  }

  if (inicio < 540 || inicio > 1080 || inicio % 30 !== 0 || fim > 1200) {
    return horarioInvalido("Fora do horario permitido");
  }

  if (horario === "12:00" || horario === "12:30") {
    return horarioInvalido("Inicio indisponivel");
  }

  // Terca: bloqueio das 09h ate 13h30.
  if (diaSemana === 2) {
    if (inicio < 810 || inicio > 930 || fim > 1050) {
      return horarioInvalido("Horario indisponivel na terca");
    }
  }

  // Quinta: bloqueio das 09h ate 12h.
  if (diaSemana === 4 && inicio < 720) {
    return horarioInvalido("Horario indisponivel na quinta");
  }

  // Quarta: mesmas janelas especiais do aplicativo.
  if (diaSemana === 3) {
    const manha = inicio >= 540 && inicio <= 630 && fim <= 750;

    const encaixe =
      inicio >= 660 && inicio <= 690 && duracao <= 60 && fim <= 750;

    const tarde = inicio >= 810 && inicio <= 930 && fim <= 1050;

    if (!manha && !encaixe && !tarde) {
      return horarioInvalido("Horario indisponivel na quarta");
    }
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
