/**
 * Sugestão visual de manutenção: não muda agendas, preços, datas persistidas
 * ou notificações. Utiliza somente aplicações concluídas.
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
 * A data relevante é a data do serviço, não a data do registro ou conclusão.
 * Retorna null se a cliente não tiver uma aplicação válida concluída.
 * Recebe nomes/categorias já resolvidos pelo frontend a partir do catálogo.
 */
export function encontrarManutencaoSugerida(atendimentos) {
  if (!Array.isArray(atendimentos)) return null;

  let ultimaAplicacao = null;
  for (const atendimento of atendimentos) {
    const status = normalizar(atendimento?.status);
    if (status !== "concluido" && status !== "realizado") continue;
    if (!ehAplicacaoDeGel({
      nome: atendimento.nomeServico || atendimento.servico || "",
      categoria: atendimento.categoria || "",
    })) continue;

    const data = interpretarDataISO(atendimento.data);
    if (!data) continue;

    const dataISO = formatarDataISO(data);
    if (!ultimaAplicacao || dataISO > ultimaAplicacao.dataAplicacaoISO) {
      data.setUTCDate(data.getUTCDate() + DIAS_SUGESTAO_MANUTENCAO);
      ultimaAplicacao = {
        dataAplicacaoISO: dataISO,
        dataSugeridaISO: formatarDataISO(data),
        servico: atendimento.nomeServico || atendimento.servico,
        dias: DIAS_SUGESTAO_MANUTENCAO,
      };
    }
  }

  return ultimaAplicacao;
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
