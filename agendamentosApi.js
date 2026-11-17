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

// Estado da saga de reagendamento PIX pago. Sem endpoint disponível, não libera a tela.
export async function consultarReagendamentoPixConfigApi(auth) {
  const usuario = auth?.currentUser;
  if (!usuario) return false;
  try {
    const token = await usuario.getIdToken();
    const resposta = await fetch("/api/agendamentos/reagendar/config", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!resposta.ok) return false;
    const dados = await resposta.json();
    return dados?.pixPagoHabilitado === true;
  } catch {
    return false;
  }
}

export async function consultarReagendamentoPixPagoApi(auth, operationId) {
  const usuario = auth?.currentUser;
  if (!usuario) throw new Error("Entre na sua conta para consultar o reagendamento.");
  const token = await usuario.getIdToken();
  const resposta = await fetch(
    `/api/agendamentos/reagendar?operationId=${encodeURIComponent(operationId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.erro || "Não foi possível consultar o reagendamento.");
  return dados;
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

/**
 * Projecao somente leitura para sugestoes da semana; uma chamada para ate 7 dias.
 * Uma resposta parcial, desconhecida ou sem autenticacao nunca libera sugestoes.
 */
export async function consultarDisponibilidadePixPeriodo(auth, datas) {
  const usuario = auth?.currentUser;
  if (!usuario) throw new Error("Entre na sua conta para consultar os horários.");
  if (!Array.isArray(datas) || datas.length < 1 || datas.length > 7 ||
      datas.some((data) => typeof data !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(data)) ||
      new Set(datas).size !== datas.length) {
    throw new TypeError("Datas de sugestão inválidas");
  }
  const token = await usuario.getIdToken();
  const parametros = new URLSearchParams({ datas: datas.join(",") });
  const resposta = await fetch(`/api/pix/disponibilidade?${parametros}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const resultado = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(resultado.erro || "Não foi possível consultar sugestões.");
  const dados = resultado?.intervalosPorData;
  if (!dados || typeof dados !== "object" || Array.isArray(dados) ||
      Object.keys(dados).length !== datas.length ||
      datas.some((data) => !Object.hasOwn(dados, data) || !Array.isArray(dados[data]))) {
    throw new Error("Resposta incompleta de disponibilidade.");
  }
  return dados;
}

// Retorna apenas o status de liberação; falhas mantêm a função indisponível.
export async function consultarLiberacaoAlterarServicoApi(auth) {
  const usuario = auth?.currentUser;
  if (!usuario) return false;
  try {
    const token = await usuario.getIdToken();
    const resposta = await fetch("/api/admin/agendamentos/servico?config=1", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!resposta.ok) return false;
    const dados = await resposta.json();
    return dados?.habilitado === true;
  } catch {
    return false;
  }
}

export async function alterarServicoAgendamentoApi(auth, dados) {
  const usuario = auth?.currentUser;
  if (!usuario) throw new Error("Faça login para continuar.");
  const token = await usuario.getIdToken();
  const resposta = await fetch("/api/admin/agendamentos/servico", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(dados),
    cache: "no-store",
  });
  const resultado = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(resultado.erro || "Não foi possível alterar o serviço.");
  return resultado;
}

export async function consultarAlteracaoServicoApi(auth, operationId) {
  const usuario = auth?.currentUser;
  if (!usuario) throw new Error("Faça login para continuar.");
  const token = await usuario.getIdToken();
  const parametros = new URLSearchParams({ operationId });
  const resposta = await fetch(`/api/admin/agendamentos/servico?${parametros}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const resultado = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(resultado.erro || "Não foi possível consultar a alteração.");
  return resultado;
}
