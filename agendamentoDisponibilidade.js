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
    return { inicioMinuto, fimMinuto };
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
  return intervalos.some((ocupado) =>
    inicio < ocupado.fimMinuto && fim > ocupado.inicioMinuto);
}
