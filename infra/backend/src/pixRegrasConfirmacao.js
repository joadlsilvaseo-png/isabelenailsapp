const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function pagamentoPixConfirmadoManualmente(agendamento) {
  return Boolean(agendamento?.pixCobrancaId || agendamento?.pixPagamentoId);
}

export function gerarIdAgendamentoPix(cobrancaId) {
  if (typeof cobrancaId !== "string" || !UUID.test(cobrancaId)) {
    throw new Error("ID da cobranca invalido");
  }

  return `pix_${cobrancaId.replaceAll("-", "").toLowerCase()}`;
}

export function validarVinculoConfirmacaoPix(cobranca, reserva) {
  if (
    !cobranca ||
    !reserva ||
    !UUID.test(String(cobranca.id || "")) ||
    String(reserva.cobranca_id) !== String(cobranca.id) ||
    !cobranca.cliente_uid ||
    reserva.cliente_uid !== cobranca.cliente_uid ||
    cobranca.estado !== "paga" ||
    !cobranca.mp_order_id ||
    !cobranca.pago_em
  ) {
    throw new Error("Pagamento e reserva nao conciliados");
  }
}

export function validarReservaVigentePix(
  reserva,
  agora = Date.now()
) {
  const vencimento = new Date(reserva.vence_em).getTime();

  if (
    reserva.estado !== "reservada" ||
    !Number.isFinite(vencimento) ||
    vencimento <= agora
  ) {
    throw new Error("Reserva vencida ou indisponivel");
  }

  if (
    !Number.isInteger(reserva.inicio_minuto) ||
    !Number.isInteger(reserva.fim_minuto) ||
    reserva.fim_minuto <= reserva.inicio_minuto ||
    typeof reserva.data_iso !== "string"
  ) {
    throw new Error("Periodo da reserva invalido");
  }

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(agora));

  const p = Object.fromEntries(
    partes.map((item) => [item.type, item.value])
  );

  const agoraLocal =
    `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;

  const inicio = reserva.inicio_minuto;

  const horario =
    `${String(Math.floor(inicio / 60)).padStart(2, "0")}:` +
    `${String(inicio % 60).padStart(2, "0")}`;

  if (`${reserva.data_iso}T${horario}` <= agoraLocal) {
    throw new Error("Horario do atendimento ja passou");
  }

  return horario;
}
