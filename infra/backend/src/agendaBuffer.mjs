/** Grade de início segue de 15 em 15 minutos; não existe intervalo obrigatório. */
export const BUFFER_ENTRE_ATENDIMENTOS_MINUTOS = 0;

export function atendimentosConflitamComBuffer(inicio, fim, inicioExistente, fimExistente, buffer = 0) {
  if (![inicio, fim, inicioExistente, fimExistente, buffer].every(Number.isInteger) ||
      inicio >= fim || inicioExistente >= fimExistente || buffer < 0) {
    throw new TypeError("Intervalo inválido para verificação de conflito");
  }
  return inicio < fimExistente + buffer && fim > inicioExistente - buffer;
}

/**
 * Proteção direcional: uma NOVA reserva não começa exatamente no término
 * de uma reserva/agendamento existente. O próximo início da grade de 15 min
 * continua livre; novo serviço pode terminar no início do próximo existente.
 * Bloqueios administrativos não criam pausa e serviços confirmados da mesma
 * cliente podem ficar consecutivos, sem permitir sobreposição real.
 *
 * ignorarProtecaoInicio: somente para efetivar um PIX já reservado e pago
 * antes da mudança, sem prejudicar a confirmação financeira.
 */
export function indisponivelComBufferSequencial(inicio, fim, intervalos, buffer = 0, opcoes = {}) {
  if (!Array.isArray(intervalos)) throw new TypeError("Lista de intervalos inválida");
  return intervalos.some((item) =>
    atendimentosConflitamComBuffer(inicio, fim, item.inicioMinuto, item.fimMinuto,
      item.tipo === "bloqueio" ? 0 : buffer) ||
    (!opcoes.ignorarProtecaoInicio && buffer === 0 &&
      item.tipo !== "bloqueio" && item.sequencialMesmaCliente !== true &&
      inicio === item.fimMinuto)
  );
}

export function indisponivelComBuffer(inicio, fim, intervalos) {
  return indisponivelComBufferSequencial(inicio, fim, intervalos, 0);
}

/** Compatibilidade com chamadores antigos: :15/:45 são inícios normais da grade. */
export function encaixeInteligenteDisponivel(inicio, fim, intervalos, validarInicio = () => true) {
  if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio % 15 !== 0 ||
      fim <= inicio || !Array.isArray(intervalos) || typeof validarInicio !== "function") return false;
  return validarInicio(inicio) && !indisponivelComBuffer(inicio, fim, intervalos);
}
