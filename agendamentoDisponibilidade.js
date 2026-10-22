/**
 * Limites dos horários de início e término exibidos na agenda.
 * Terça e quarta mantêm suas regras especiais em agendamento.js.
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
