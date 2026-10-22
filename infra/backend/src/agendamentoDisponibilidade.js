/**
 * Limites dos horários de início e término exibidos na agenda.
 * As exceções de terça e quarta são compartilhadas entre frontend e backend.
 * Quinta e sexta permitem início até 19h e término até 21h.
 * No sábado, o último horário de início é 16h; o serviço pode terminar depois.
 * A pausa de almoço de 13h30 a 14h é bloqueada por intervalo em agendamento.js e no validador PIX.
 */
export function obterLimitesAtendimentoSemanal(diaSemana) {
  const horarioEstendido = diaSemana === 4 || diaSemana === 5;
  const sabado = diaSemana === 6;
  return {
    minAbertura: diaSemana === 4 ? 660 : 540,
    minUltimoInicio: sabado ? 960 : horarioEstendido ? 1140 : 1080,
    minFechamento: sabado ? 1440 : horarioEstendido ? 1260 : 1200,
  };
}

/** Quarta-feira oferece apenas estes dois horários de início. */
export function obterIniciosEspeciaisSemanais(diaSemana) {
  return diaSemana === 3 ? [540, 840] : null;
}

/** Regras especiais compartilhadas pelo calendário e pelo validador de reservas. */
export function validarHorarioEspecialSemanal(diaSemana, inicioMinuto, duracaoMinutos) {
  const fimMinuto = inicioMinuto + duracaoMinutos;

  if (diaSemana === 2) {
    return inicioMinuto >= 840 && inicioMinuto <= 930 && inicioMinuto % 30 === 0 && fimMinuto <= 1050;
  }

  if (diaSemana === 3) {
    if (inicioMinuto === 540) return fimMinuto <= 750;
    if (inicioMinuto === 840) return fimMinuto <= 1050;
    return false;
  }

  return true;
}

function validarIntervalos(intervalos) {
  if (!Array.isArray(intervalos)) {
    throw new Error("A disponibilidade retornou um formato inválido.");
  }
  return intervalos.map((intervalo) => {
    const inicioMinuto = Number(intervalo?.inicioMinuto);
    const fimMinuto = Number(intervalo?.fimMinuto);
    if (!Number.isInteger(inicioMinuto) || !Number.isInteger(fimMinuto) ||
        inicioMinuto < 0 || fimMinuto > 1440 || inicioMinuto >= fimMinuto) {
      throw new Error("A disponibilidade retornou um intervalo inválido.");
    }
    return { inicioMinuto, fimMinuto };
  });
}

/** Both sources are required. If either one fails, callers must fail closed. */
export async function consultarIntervalosDisponibilidade({
  consultarAgendamentosFirestore,
  consultarReservasPix,
}) {
  const [agendamentos, reservasPix] = await Promise.all([
    consultarAgendamentosFirestore(),
    consultarReservasPix(),
  ]);
  return [
    ...validarIntervalos(agendamentos),
    ...validarIntervalos(reservasPix),
  ];
}

export function intervaloSobrepoeDisponibilidade(inicio, fim, intervalos) {
  return intervalos.some((ocupado) =>
    inicio < ocupado.fimMinuto && fim > ocupado.inicioMinuto);
}

