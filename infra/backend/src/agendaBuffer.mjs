/**
 * Intervalo técnico de 20 minutos ENTRE atendimentos.
 * O procedimento, sua cobrança e o evento Calendar mantêm duração real.
 */
export const BUFFER_ENTRE_ATENDIMENTOS_MINUTOS = 20;

export function atendimentosConflitamComBuffer(
  inicio, fim, inicioExistente, fimExistente,
  buffer = BUFFER_ENTRE_ATENDIMENTOS_MINUTOS,
) {
  if (![inicio, fim, inicioExistente, fimExistente, buffer].every(Number.isInteger)
    || inicio >= fim || inicioExistente >= fimExistente || buffer < 0) {
    throw new TypeError("Intervalos de atendimento inválidos");
  }
  return inicio < fimExistente + buffer && fim > inicioExistente - buffer;
}

export function indisponivelComBuffer(inicio, fim, intervalos) {
  if (!Array.isArray(intervalos)) throw new TypeError("Lista de intervalos inválida");
  return intervalos.some((intervalo) => intervalo.tipo === "bloqueio"
    ? inicio < intervalo.fimMinuto && fim > intervalo.inicioMinuto
    : atendimentosConflitamComBuffer(inicio, fim, intervalo.inicioMinuto, intervalo.fimMinuto));
}
