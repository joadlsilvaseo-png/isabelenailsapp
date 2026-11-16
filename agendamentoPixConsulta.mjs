/**
 * A consulta visual não deve pedir à API para excluir uma reserva com PIX pago.
 * O agendamento original permanece protegido no PostgreSQL; a confirmação
 * do reagendamento é feita pelo fluxo transacional existente no backend.
 */
export function obterIdConsultaDisponibilidadePix(reagendarId, agendamentoOriginal) {
  if (!reagendarId || !agendamentoOriginal) return null;
  if (agendamentoOriginal.pixCobrancaId || agendamentoOriginal.pixPagamentoId) return null;
  return reagendarId;
}
