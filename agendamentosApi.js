export async function executarAcaoAgendamento(
  auth,
  { agendamentoId, acao, valorFinal },
) {
  const usuario = auth?.currentUser;

  if (!usuario) {
    throw new Error("Faca login para continuar.");
  }

  const token = await usuario.getIdToken();

  const resposta = await fetch("/api/agendamentos/acao", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agendamentoId,
      acao,
      ...(valorFinal !== undefined ? { valorFinal } : {}),
    }),
  });

  const dados = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    throw new Error(
      dados.erro || "Nao foi possivel atualizar o agendamento.",
    );
  }

  return dados;
}

export async function reagendarAgendamentoApi(auth, dados) {
  const usuario = auth?.currentUser;
  if (!usuario) throw new Error("Faça login para continuar.");
  const token = await usuario.getIdToken();
  const resposta = await fetch("/api/agendamentos/reagendar", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(dados),
    cache: "no-store",
  });
  const resultado = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(resultado.erro || "Não foi possível reagendar.");
  return resultado;
}

export async function consultarDisponibilidadePix(auth, data, agendamentoId = null) {
  const usuario = auth?.currentUser;
  if (!usuario) throw new Error("Entre na sua conta para consultar os horários.");
  const token = await usuario.getIdToken();
  const parametros = new URLSearchParams({ data });
  if (agendamentoId) parametros.set("agendamentoId", agendamentoId);
  const resposta = await fetch(`/api/pix/disponibilidade?${parametros}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const resultado = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    throw new Error(resultado.erro || "Não foi possível confirmar a disponibilidade.");
  }
  return resultado.intervalos;
}
