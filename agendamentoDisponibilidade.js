import { indisponivelComBuffer, encaixeInteligenteDisponivel } from "./infra/backend/src/agendaBuffer.mjs";

/**
 * Limites dos horários de início e término exibidos na agenda.
 * Terça e quarta mantêm suas regras especiais em agendamento.js.
 * Quinta e sexta encerram os atendimentos às 21h (último início 20h30).
 * Sábado: inícios até 17h, término às 18h, salvo 16h/150 min (18h30).
 * Sem pausa fixa de almoço: intervalos são gerenciados manualmente no calendário.
 */
export function obterLimitesAtendimentoSemanal(diaSemana) {
  // O encerramento corresponde ao término real do último atendimento.
  const periodos = {
    2: { minAbertura: 840, minFechamento: 1050 }, // Terça
    3: { minAbertura: 540, minFechamento: 1050 }, // Quarta: pausa entre janelas
    4: { minAbertura: 660, minFechamento: 1260 }, // Quinta
    5: { minAbertura: 540, minFechamento: 1260 }, // Sexta
    6: { minAbertura: 540, minFechamento: 1110 }, // Sábado: exceção 16h/150min
  };
  const limites = periodos[diaSemana] || { minAbertura: 0, minFechamento: 0 };
  return { ...limites, minUltimoInicio: limites.minFechamento - 30 };
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

/** Horários adicionais (:15/:45) apenas para lacunas reais e serviços que cabem. */
export function listarIniciosEncaixe({ abertura, ultimoInicio, duracao, intervalos, validarInicio, validarInicioPadrao }) {
  if (!Number.isInteger(abertura) || !Number.isInteger(ultimoInicio) ||
      !Number.isInteger(duracao) || duracao <= 0 || !Array.isArray(intervalos) ||
      typeof validarInicio !== "function" || typeof validarInicioPadrao !== "function") {
    throw new TypeError("Parâmetros inválidos para encaixes inteligentes");
  }
  const inicios = [];
  for (let minuto = Math.ceil(abertura / 15) * 15; minuto <= ultimoInicio; minuto += 15) {
    if (minuto % 30 !== 15 || !validarInicio(minuto)) continue;
    if (encaixeInteligenteDisponivel(minuto, minuto + duracao, intervalos, validarInicioPadrao)) {
      inicios.push(minuto);
    }
  }
  return inicios;
}

/**
 * Grade nativa: todas as opções em intervalos de 15min.
 * A validação de janela comercial (incluindo dezembro) vem do mesmo
 * módulo do backend. Ocupação, buffer e bloqueios são aplicados em conjunto.
 */
export function listarIniciosGrade15({ abertura, ultimoInicio, duracao, validarInicio }) {
  if (![abertura, ultimoInicio, duracao].every(Number.isInteger) ||
      duracao <= 0 || typeof validarInicio !== "function") {
    throw new TypeError("Parâmetros inválidos da grade de 15 minutos");
  }
  const horarios = [];
  for (let minuto = Math.ceil(abertura / 15) * 15; minuto <= ultimoInicio; minuto += 15) {
    if (validarInicio(minuto)) horarios.push(minuto);
  }
  return horarios;
}
