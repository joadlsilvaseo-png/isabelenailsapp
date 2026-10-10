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