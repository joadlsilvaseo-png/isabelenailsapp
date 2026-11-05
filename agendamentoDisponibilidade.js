import { indisponivelComBuffer } from "./infra/backend/src/agendaBuffer.mjs";

/**
 * Limites dos horários de início e término exibidos na agenda.
 * Terça e quarta mantêm suas regras especiais em agendamento.js.
 * Quinta e sexta encerram os atendimentos às 21h (último início 20h30).
 * Sábado: inícios até 17h, término às 18h, salvo 16h/150 min (18h30).
 * Sem pausa fixa de almoço: intervalos são gerenciados manualmente no calendário.
 */
export function obterLimitesAtendimentoSemanal(diaSemana) {
  const horarioEstendido = diaSemana === 4 || diaSemana === 5;
  const sabado = diaSemana === 6;
  return {
    minAbertura: diaSemana === 4 ? 660 : 540,
    minUltimoInicio: sabado ? 1020 : horarioEstendido ? 1230 : 1080,
    minFechamento: sabado ? 1110 : horarioEstendido ? 1260 : 1200,
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
    const tipo = intervalo?.tipo;
    if (tipo !== undefined && !["bloqueio", "reserva", "agendamento"].includes(tipo)) {
      throw new Error("A disponibilidade retornou um tipo inválido.");
    }
    return { inicioMinuto, fimMinuto, ...(tipo ? { tipo } : {}) };
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
  return indisponivelComBuffer(inicio, fim, intervalos);
}
