import { indisponivelComBufferSequencial, encaixeInteligenteDisponivel } from "./infra/backend/src/agendaBuffer.mjs";
import { obterJanelasAtendimentoSemanal } from "./infra/backend/src/agendamentoRegras.mjs?v=2.1.0";

/**
 * Resumo visual dos limites semanais. A validação definitiva usa
 * obterJanelasAtendimento(data) para respeitar manhã/tarde separadas
 * e a duração real de cada serviço.
 */
export function obterLimitesAtendimentoSemanal(diaSemana) {
  const janelas = obterJanelasAtendimentoSemanal(diaSemana);
  if (!janelas.length) return { minAbertura: null, minUltimoInicio: null, minFechamento: null };
  const abertura = Math.min(...janelas.map((j) => j.inicioMinuto));
  const encerramento = Math.max(...janelas.map((j) => j.encerramentoMinuto));
  return {
    minAbertura: abertura,
    minUltimoInicio: encerramento - 15,
    // Exceção de sábado: a gestão permite fechar até 18h30 (16h/150 min).
    minFechamento: diaSemana === 6 ? 1110 : encerramento,
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
    return { inicioMinuto, fimMinuto, ...(tipo ? { tipo } : {}),
      ...(intervalo.sequencialMesmaCliente === true ? { sequencialMesmaCliente: true } : {}) };
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
  return indisponivelComBufferSequencial(inicio, fim, intervalos);
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
