/**
 * Intervalo técnico de 15 minutos ENTRE atendimentos.
 * O procedimento, sua cobrança e o evento Calendar mantêm duração real.
 */
export const BUFFER_ENTRE_ATENDIMENTOS_MINUTOS = 15;

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

/**
 * A exceção aceita SOMENTE o encaixe exatamente consecutivo de agendamentos
 * confirmados da mesma conta (sinal calculado pelo servidor ou Firestore).
 * Bloqueios nunca são dispensados. Status pendente e outras clientes não elegíveis.
 * A sobreposição física jamais é permitida.
 */
export function indisponivelComBufferSequencial(inicio, fim, intervalos, buffer = BUFFER_ENTRE_ATENDIMENTOS_MINUTOS) {
  if (!Array.isArray(intervalos)) throw new TypeError("Lista de intervalos inválida");
  return intervalos.some((item) => {
    if (item.tipo === "bloqueio") {
      return inicio < item.fimMinuto && fim > item.inicioMinuto;
    }
    if (!atendimentosConflitamComBuffer(inicio, fim, item.inicioMinuto, item.fimMinuto, buffer)) return false;
    const consecutivo = inicio === item.fimMinuto || fim === item.inicioMinuto;
    return !(item.sequencialMesmaCliente === true && consecutivo);
  });
}

export function indisponivelComBuffer(inicio, fim, intervalos) {
  if (!Array.isArray(intervalos)) throw new TypeError("Lista de intervalos inválida");
  return intervalos.some((intervalo) => intervalo.tipo === "bloqueio"
    ? inicio < intervalo.fimMinuto && fim > intervalo.inicioMinuto
    : atendimentosConflitamComBuffer(inicio, fim, intervalo.inicioMinuto, intervalo.fimMinuto));
}

/**
 * Encaixes :15/:45 só existem ENTRE dois atendimentos ativos e com respiro
 * de 15 minutos de cada lado. Bloqueios manuais não geram encaixes.
 * Quando um início padrão (:00/:30) válido para o mesmo serviço cabe na
 * lacuna, evitamos abrir horários intermediários desnecessários.
 */
export function encaixeInteligenteDisponivel(inicio, fim, intervalos, validarInicioPadrao = () => true) {
  if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio % 30 !== 15 ||
      fim <= inicio || !Array.isArray(intervalos) || typeof validarInicioPadrao !== "function" ||
      indisponivelComBuffer(inicio, fim, intervalos)) return false;
  const atendimentos = intervalos.filter((item) => item.tipo !== "bloqueio");
  const anteriores = atendimentos.filter((item) => item.fimMinuto <= inicio);
  const posteriores = atendimentos.filter((item) => item.inicioMinuto >= fim);
  if (!anteriores.length || !posteriores.length) return false;
  const fimAnterior = Math.max(...anteriores.map((item) => item.fimMinuto));
  const inicioProximo = Math.min(...posteriores.map((item) => item.inicioMinuto));
  const buffer = BUFFER_ENTRE_ATENDIMENTOS_MINUTOS;
  if (inicio - fimAnterior < buffer || inicioProximo - fim < buffer) return false;

  const duracao = fim - inicio;
  const primeiroPadrao = Math.ceil((fimAnterior + buffer) / 30) * 30;
  for (let candidato = primeiroPadrao; candidato + duracao + buffer <= inicioProximo; candidato += 30) {
    if (validarInicioPadrao(candidato) &&
        !indisponivelComBuffer(candidato, candidato + duracao, intervalos)) return false;
  }
  return true;
}
