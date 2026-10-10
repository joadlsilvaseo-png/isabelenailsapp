const STATUS_OCUPADOS = new Set([
  "agendado", "reagendado", "confirmado"
]);

export function encontrarConflitoAgendamentoPix(registros, inicio, fim) {
  for (const registro of registros) {
    if (!STATUS_OCUPADOS.has(registro.status)) continue;

    const horario = String(registro.horario || "");

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
      throw new Error("Agendamento ativo com horario invalido");
    }

    const [h, m] = horario.split(":").map(Number);
    const comeco = h * 60 + m;
    const duracao = Number(registro.duracao) || 90;

    if (
      !Number.isFinite(duracao) ||
      duracao <= 0 ||
      duracao > 1440
    ) {
      throw new Error("Agendamento ativo com duracao invalida");
    }

    if (inicio < comeco + duracao && fim > comeco) {
      return true;
    }
  }

  return false;
}

export function montarAgendamentoPix({
  cobranca, reserva, nomeCliente
}) {
  const total = Number(cobranca.valor_total_centavos);
  const sinal = Number(cobranca.valor_sinal_centavos);
  const restante = Number(cobranca.valor_restante_centavos);
  const duracao = reserva.fim_minuto - reserva.inicio_minuto;

  if (
    !Number.isSafeInteger(total) || total <= 0 ||
    !Number.isSafeInteger(sinal) || sinal <= 0 ||
    !Number.isSafeInteger(restante) || restante < 0 ||
    total !== sinal + restante ||
    !Number.isInteger(duracao) || duracao <= 0 ||
    !Number.isInteger(reserva.inicio_minuto) ||
    typeof reserva.data_iso !== "string"
  ) {
    throw new Error("Dados financeiros ou periodo invalidos");
  }

  const horario = [
    String(Math.floor(reserva.inicio_minuto / 60)).padStart(2, "0"),
    String(reserva.inicio_minuto % 60).padStart(2, "0")
  ].join(":");

  return {
    clienteId: cobranca.cliente_uid,
    nomeCliente: String(nomeCliente || "Cliente").trim().slice(0, 120),
    servico: String(cobranca.reserva_dados?.nomeServico || "Servico"),
    idServico: reserva.servico_id,
    data: reserva.data_iso,
    horario,
    duracao,
    precoSnapshot: total / 100,
    duracaoSnapshot: duracao,
    observacoes: "",
    status: "confirmado",
    origemPagamento: "mercado_pago_pix",
    pixCobrancaId: cobranca.id,
    pixReservaId: reserva.id,
    valorSinalCentavos: sinal,
    valorRestanteCentavos: restante
  };
}