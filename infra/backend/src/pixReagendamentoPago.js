// Reagendamento de PIX pago: o script original da criacao deve confirmar
// explicitamente que reconhece REAGENDAR e encontra o MESMO eventId.
// Nao usar a URL do frontend/Apps Script de outro projeto como fallback.
const URL_ENV = "PIX_REAGENDAMENTO_PAGO_APPS_SCRIPT_URL";
const FLAG_ENV = "PIX_REAGENDAMENTO_PAGO_ENABLED";
const URL_GAS = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

export function pixPagoReagendamentoHabilitado() {
  // A sincronização transacional entre Firestore, PostgreSQL e Calendar
  // ainda NÃO foi implementada. Não permitir habilitação por variável de
  // ambiente ou configuração no navegador enquanto a operação é parcial.
  return false;
}

export function validarPagamentoPixReagendamento({
  agendamento, reserva, servicoId, agendamentoId,
}) {
  const chargeId = String(agendamento?.pixCobrancaId || "");
  if (!chargeId || !reserva ||
      String(reserva.cobranca_id || "") !== chargeId ||
      String(reserva.cobranca_cliente_uid || "") !== String(agendamento.clienteId || "") ||
      String(reserva.cliente_uid || "") !== String(agendamento.clienteId || "") ||
      String(reserva.agendamento_id || "") !== agendamentoId ||
      String(reserva.cobranca_agendamento_id || "") !== agendamentoId ||
      reserva.cobranca_estado !== "paga" ||
      reserva.estado !== "confirmada" ||
      String(reserva.servico_id || "") !== servicoId ||
      String(agendamento.idServico || agendamento.servicoId || "") !== servicoId) {
    return { valido: false, motivo: "Sinal PIX, reserva ou serviço não conciliado; consulte a profissional." };
  }
  if (agendamento.pixStatusFinanceiro &&
      agendamento.pixStatusFinanceiro !== "pago") {
    return { valido: false, motivo: "Sinal PIX não está em situação paga." };
  }
  return { valido: true };
}

export function montarPayloadReagendamentoPix({
  eventId, operationId, data, horario, duracao, nomeCliente, servico,
}) {
  if (!eventId || !operationId || !/^\d{4}-\d{2}-\d{2}$/.test(data) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario) ||
      !Number.isSafeInteger(duracao) || duracao <= 0 || duracao > 600 ||
      !String(nomeCliente || "").trim() || !String(servico || "").trim()) {
    throw new Error("Dados insuficientes para sincronizar o reagendamento PIX");
  }
  return {
    acao: "REAGENDAR",
    eventId, operationId,
    nomeCliente: String(nomeCliente).trim(),
    servico: String(servico).trim(),
    dataInicio: `${data}T${horario}:00`,
    duracaoMinutos: duracao,
  };
}

export async function enviarReagendamentoPix(payload, fetcher = fetch, url = process.env[URL_ENV]) {
  const destino = String(url || "").trim();
  if (!URL_GAS.test(destino)) throw new Error("Implantação de reagendamento PIX não validada");
  const resposta = await fetcher(destino, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!resposta.ok) throw new Error("Google Calendar não confirmou reagendamento PIX");
  const raw = await resposta.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("Google Calendar não retornou confirmação JSON de reagendamento"); }
  if (json?.ok !== true ||
      (json.reagendado !== true && json.updated !== true) ||
      json.eventId !== payload.eventId) {
    throw new Error("Google Calendar não confirmou alteração do mesmo evento");
  }
  return json;
}
