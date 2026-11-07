/** A grade segue de 15 em 15 minutos. O buffer SQL legado continua zero. */
export const BUFFER_ENTRE_ATENDIMENTOS_MINUTOS = 0;
/** Proteção apenas APÓS o término de um compromisso existente, não antes dele. */
export const PROTECAO_INICIO_MINUTOS = 15;

export function atendimentosConflitamComBuffer(inicio, fim, inicioExistente, fimExistente, buffer = 0) {
  if (![inicio, fim, inicioExistente, fimExistente, buffer].every(Number.isInteger) ||
      inicio >= fim || inicioExistente >= fimExistente || buffer < 0) {
    throw new TypeError("Intervalo inválido para verificação de conflito");
  }
  return inicio < fimExistente + buffer && fim > inicioExistente - buffer;
}

/**
 * Proteção assimétrica de 15 min: um novo início não pode encostar no FIM
 * de um compromisso anterior de outra cliente. Terminar no INÍCIO de um
 * compromisso futuro é permitido. Bloqueios manuais só impedem sobreposição.
 *
 * O parâmetro buffer=0 é uma exceção explícita de compatibilidade usada na
 * confirmação de um hold PIX já aceito anteriormente à implantação da regra.
 */
export function indisponivelComBufferSequencial(inicio, fim, intervalos, buffer = PROTECAO_INICIO_MINUTOS) {
  if (!Array.isArray(intervalos)) throw new TypeError("Lista de intervalos inválida");
  return intervalos.some((item) => {
    const ocupado = atendimentosConflitamComBuffer(
      inicio, fim, item.inicioMinuto, item.fimMinuto, 0,
    );
    if (ocupado) return true;
    if (item.tipo === "bloqueio" || item.sequencialMesmaCliente === true) return false;
    if (!Number.isInteger(buffer) || buffer < 0) throw new TypeError("Proteção inválida");
    return inicio >= item.fimMinuto && inicio < item.fimMinuto + buffer;
  });
}

export function indisponivelComBuffer(inicio, fim, intervalos) {
  return indisponivelComBufferSequencial(inicio, fim, intervalos);
}

/** Compatibilidade com chamadores antigos: :15/:45 são inícios normais da grade. */
export function encaixeInteligenteDisponivel(inicio, fim, intervalos, validarInicio = () => true) {
  if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio % 15 !== 0 ||
      fim <= inicio || !Array.isArray(intervalos) || typeof validarInicio !== "function") return false;
  return validarInicio(inicio) && !indisponivelComBuffer(inicio, fim, intervalos);
}
