/**
 * Sugestão visual de manutenção: não muda agendas, preços, datas persistidas
 * ou notificações. Utiliza aplicações e manutenções de gel concluídas.
 */
export const DIAS_SUGESTAO_MANUTENCAO = 21;

function normalizar(valor) {
  return String(valor ?? "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function interpretarDataISO(data) {
  if (typeof data !== "string") return null;
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.trim());
  if (!partes) return null;

  const [, anoTexto, mesTexto, diaTexto] = partes;
  const ano = Number(anoTexto);
  const mes = Number(mesTexto);
  const dia = Number(diaTexto);
  const dataUTC = new Date(Date.UTC(ano, mes - 1, dia));
  if (dataUTC.getUTCFullYear() !== ano ||
      dataUTC.getUTCMonth() !== mes - 1 ||
      dataUTC.getUTCDate() !== dia) return null;
  return dataUTC;
}

function formatarDataISO(dataUTC) {
  return [
    dataUTC.getUTCFullYear(),
    String(dataUTC.getUTCMonth() + 1).padStart(2, "0"),
    String(dataUTC.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

/** Não confundir serviços de esmaltação, manutenção ou remoção com aplicação. */
export function ehAplicacaoDeGel({ nome = "", categoria = "" } = {}) {
  const nomeServico = normalizar(nome);
  const categoriaServico = normalizar(categoria).replace(/-/g, " ");

  if (!nomeServico ||
      /\b(manutencao|retoque|retorno|remocao|retirada|reparo|conserto)\b/.test(nomeServico) ||
      /\b(esmalta(?:cao|r)|manicure|pedicure|simples)\b/.test(nomeServico)) {
    return false;
  }

  const contextoGel = /\b(gel|fibra de vidro|fibra)\b/.test(nomeServico) ||
    /\b(unhas em gel|unhas gel|gel)\b/.test(categoriaServico);
  const aplicacao = /\b(aplicacao|alongamento|banho de gel|fibra de vidro|gel na tips|gel moldado|unhas em gel)\b/.test(nomeServico);

  return contextoGel && aplicacao;
}

/**
 * Manutenção de unhas em gel/fibra reinicia o mesmo ciclo de 21 dias.
 * Evita classificar cílios, esmaltação, manicure ou pedicure como manutenção de gel.
 */
function contextoGel(nome, categoria) {
  const descricao = nome + " " + categoria;
  if (/\b(cilios|cilio|lash|sobrancelha|cabelo|capilar)\b/.test(descricao)) return false;
  const gelOuFibra = /\b(gel|fibra|acrigel)\b/.test(nome);
  const categoriaUnhas = /\b(unhas? em gel|unhas? gel|alongamento|fibra|gel)\b/.test(categoria);
  const alongamentoSemCategoria = !categoria && /\balongamento\b/.test(nome);
  return gelOuFibra || categoriaUnhas || alongamentoSemCategoria;
}

export function ehManutencaoDeGel({ nome = "", categoria = "" } = {}) {
  const n = normalizar(nome);
  const c = normalizar(categoria).replace(/-/g, " ");
  if (!n || /\b(remocao|retirada|retirar|esmalta(?:cao|r)|manicure|pedicure|reparo|conserto)\b/.test(n)) return false;
  return /\b(manutencao|retoque)\b/.test(n) && contextoGel(n, c);
}

export function ehRemocaoDeGel({ nome = "", categoria = "" } = {}) {
  const n = normalizar(nome);
  const c = normalizar(categoria).replace(/-/g, " ");
  return /\b(remocao|retirada|retirar)\b/.test(n) && contextoGel(n, c);
}

export function ehProcedimentoCicloGel(servico) {
  return ehAplicacaoDeGel(servico) || ehManutencaoDeGel(servico);
}

/**
 * Reinicia o prazo de 21 dias a partir da última aplicação OU manutenção concluída.
 * Remoção posterior encerra o ciclo; serviços não relacionados não reiniciam o prazo.
 * A data usada é a do atendimento, não a da criação do registro.
 */
export function encontrarManutencaoSugerida(atendimentos) {
  if (!Array.isArray(atendimentos)) return null;

  let ultimoEventoGel = null;
  for (const atendimento of atendimentos) {
    const status = normalizar(atendimento?.status);
    if (status !== "concluido" && status !== "realizado") continue;

    const nome = atendimento.nomeServico || atendimento.servico || "";
    const categoria = atendimento.categoria || "";
    const servico = { nome, categoria };
    const tipo = ehRemocaoDeGel(servico) ? "remocao"
      : ehManutencaoDeGel(servico) ? "manutencao"
        : ehAplicacaoDeGel(servico) ? "aplicacao" : null;
    if (!tipo) continue;

    const data = interpretarDataISO(atendimento.data);
    if (!data) continue;
    const dataISO = formatarDataISO(data);
    // Na mesma data, dar preferência à remoção para evitar sugestão indevida.
    if (ultimoEventoGel && (dataISO < ultimoEventoGel.dataISO ||
      (dataISO === ultimoEventoGel.dataISO && ultimoEventoGel.tipo === "remocao"))) continue;
    ultimoEventoGel = { dataISO, data, tipo, nome };
  }

  if (!ultimoEventoGel || ultimoEventoGel.tipo === "remocao") return null;
  const dataSugerida = new Date(ultimoEventoGel.data);
  dataSugerida.setUTCDate(dataSugerida.getUTCDate() + DIAS_SUGESTAO_MANUTENCAO);
  return {
    dataUltimoAtendimentoISO: ultimoEventoGel.dataISO,
    dataSugeridaISO: formatarDataISO(dataSugerida),
    servico: ultimoEventoGel.nome,
    tipoProcedimento: ultimoEventoGel.tipo,
    dias: DIAS_SUGESTAO_MANUTENCAO,
  };
}

/** Apenas para a data da nova sugestão; não reformata datas existentes. */
export function formatarDataSugestao(iso) {
  const data = interpretarDataISO(iso);
  if (!data) return "";
  return [
    String(data.getUTCDate()).padStart(2, "0"),
    String(data.getUTCMonth() + 1).padStart(2, "0"),
    data.getUTCFullYear(),
  ].join("/");
}
