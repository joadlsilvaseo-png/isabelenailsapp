export function alternarIntervalo(selecoes, data, inicio) {
  const intervalos = new Set(selecoes.get(data) || []);
  if (intervalos.has(inicio)) intervalos.delete(inicio);
  else intervalos.add(inicio);
  if (intervalos.size) selecoes.set(data, intervalos);
  else selecoes.delete(data);
  return selecoes;
}

export function removerIntervalos(selecoes, data, inicios) {
  const intervalos = new Set(selecoes.get(data) || []);
  for (const inicio of inicios) intervalos.delete(inicio);
  if (intervalos.size) selecoes.set(data, intervalos);
  else selecoes.delete(data);
  return selecoes;
}

export function agruparIntervalos(inicios, duracao = 30) {
  const ordenados = [...new Set(inicios)].sort((a, b) => a - b);
  const grupos = [];
  for (const inicio of ordenados) {
    const anterior = grupos.at(-1);
    if (anterior && anterior.fim === inicio) {
      anterior.fim += duracao;
      anterior.inicios.push(inicio);
    } else {
      grupos.push({ inicio, fim: inicio + duracao, inicios: [inicio] });
    }
  }
  return grupos;
}

export function resumirSelecoes(selecoes) {
  const datas = [...selecoes.entries()]
    .filter(([, inicios]) => inicios.size)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([data, inicios]) => ({
      data,
      grupos: agruparIntervalos(inicios),
      quantidadeIntervalos: inicios.size,
    }));
  return {
    datas,
    quantidadeDatas: datas.length,
    quantidadeIntervalos: datas.reduce((total, item) => total + item.quantidadeIntervalos, 0),
  };
}

export function criarPayloadLote(selecoes, acao) {
  return {
    acao,
    datas: resumirSelecoes(selecoes).datas.map(({ data }) => ({
      data,
      horas: [...selecoes.get(data)].sort((a, b) => a - b),
    })),
  };
}

export function limparDatasAplicadas(selecoes, datasAplicadas) {
  for (const data of datasAplicadas) selecoes.delete(data);
  return selecoes;
}

export function obterDataAtiva(datasDisponiveis, dataAnterior = null) {
  if (!datasDisponiveis.length) return null;
  return datasDisponiveis.includes(dataAnterior) ? dataAnterior : datasDisponiveis[0];
}

export function iniciarOperacaoCalendario(estado) {
  if (estado.salvando || estado.carregando || estado.erroConsulta) return false;
  estado.salvando = true;
  return true;
}

export function encerrarOperacaoCalendario(estado) {
  estado.salvando = false;
}

export function formatarErroCalendario(status, dados = {}) {
  if (status === 401) return "Sua sessão expirou. Entre novamente para continuar.";
  if (status === 403) return "Acesso administrativo negado. Confira sua conta e tente novamente.";
  const detalhe = typeof dados.erro === "string" ? dados.erro.trim() : "";
  if (detalhe) return `Erro ${status}: ${detalhe}`;
  if (status === 503 || status >= 500) return `O serviço do calendário está indisponível (HTTP ${status}). Tente novamente.`;
  return `Não foi possível concluir a operação (HTTP ${status}). Tente novamente.`;
}

export function formatarFalhaDeRede(erro) {
  if (["AbortError", "TimeoutError"].includes(erro?.name)) {
    return "A consulta demorou mais que o esperado. Verifique a conexão e tente novamente.";
  }
  if (erro instanceof TypeError) {
    return "Não foi possível conectar à API do calendário. Verifique sua conexão e tente novamente.";
  }
  return erro?.message || "Falha inesperada ao acessar o calendário. Tente novamente.";
}
