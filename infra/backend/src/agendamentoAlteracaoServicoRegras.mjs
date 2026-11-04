import { validarHorarioPix } from "./pixDisponibilidade.js";
import { validarServicoDezembro2026 } from "./agendamentoRegras.mjs";

export const STATUS_ALTERAVEIS_SERVICO = new Set(["reagendado", "confirmado"]);

export function calcularRestanteServicoCentavos(precoNovoCentavos, sinalPagoCentavos) {
  if (!Number.isSafeInteger(precoNovoCentavos) || precoNovoCentavos <= 0 ||
      !Number.isSafeInteger(sinalPagoCentavos) || sinalPagoCentavos < 0) {
    throw new RangeError("Valores financeiros inválidos para a alteração.");
  }
  return Math.max(0, precoNovoCentavos - sinalPagoCentavos);
}

export function validarNovoPeriodoServico({ data, horario, duracao, servico, now = new Date() }) {
  const periodo = validarHorarioPix(data, horario, duracao, now);
  if (!periodo.valido) return periodo;
  const permitido = validarServicoDezembro2026(data, servico);
  if (!permitido.valido) return permitido;
  return { ...periodo, valido: true };
}

export function possuiConflitoNovoPeriodo(inicio, fim, intervalos = []) {
  return intervalos.some((intervalo) => inicio < intervalo.fim && fim > intervalo.inicio);
}
