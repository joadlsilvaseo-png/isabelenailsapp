/**
 * Planejamento puro de bloqueios administrativos mistos (15/30 minutos).
 * - Não altera, de forma alguma, dados do PIX.
 * - Um bloqueio legado de 30 min pode ser aberto pela metade sem
 *   liberar os 15 min restantes: divide somente o trecho que sobra.
 * - As operações reais são executadas sob o lock da data, em transação.
 */
export const DURACAO_BLOQUEIO_MINUTOS = 15;

function cobre(inicio, fim, outroInicio, outroFim) {
  return inicio < outroFim && fim > outroInicio;
}

function normalizar(linha) {
  const inicioMinuto = Number(linha.inicioMinuto ?? linha.inicio_minuto);
  const fimMinuto = Number(linha.fimMinuto ?? linha.fim_minuto);
  if (!Number.isInteger(inicioMinuto) || !Number.isInteger(fimMinuto) ||
      inicioMinuto < 0 || fimMinuto > 1440 || inicioMinuto % 15 !== 0 ||
      (fimMinuto - inicioMinuto !== 15 && !(fimMinuto - inicioMinuto === 30 && inicioMinuto % 30 === 0))) {
    throw new Error("Bloqueio armazenado fora do padrão 15/30 minutos");
  }
  return {
    inicioMinuto,
    fimMinuto,
    uid: linha.uid ?? linha.alterado_por_uid,
    criadoEm: linha.criadoEm ?? linha.criado_em,
  };
}

export class ConflitoBloqueio extends Error {}

export function planejarAlteracaoBloqueios(registros, horas, acao, uid) {
  if (!Array.isArray(registros) || !Array.isArray(horas) ||
      !["fechar", "reabrir"].includes(acao)) throw new TypeError("Parâmetros inválidos");
  const originais = registros.map(normalizar);
  const estado = [...originais];
  for (const inicio of horas) {
    if (!Number.isInteger(inicio) || inicio % 15 !== 0 ||
        inicio < 0 || inicio + 15 > 1440) throw new TypeError("Início inválido");
    const fim = inicio + 15;
    const envolvidos = estado.filter((b) => cobre(b.inicioMinuto, b.fimMinuto, inicio, fim));
    if (acao === "fechar") {
      if (envolvidos.length) {
        throw new ConflitoBloqueio("Este intervalo já está fechado; atualize o calendário.");
      }
      estado.push({ inicioMinuto: inicio, fimMinuto: fim, uid, criadoEm: null });
      continue;
    }
    if (envolvidos.length !== 1 ||
        envolvidos[0].inicioMinuto > inicio || envolvidos[0].fimMinuto < fim) {
      throw new ConflitoBloqueio("Este intervalo não está integralmente fechado; atualize o calendário.");
    }
    const atual = envolvidos[0];
    estado.splice(estado.indexOf(atual), 1);
    // Abre apenas o intervalo selecionado. Mantém o resto com os
    // metadados originais da profissional.
    if (atual.inicioMinuto < inicio) {
      estado.push({ ...atual, fimMinuto: inicio });
    }
    if (fim < atual.fimMinuto) {
      estado.push({ ...atual, inicioMinuto: fim });
    }
  }
  const chave = (r) => r.inicioMinuto + ":" + r.fimMinuto;
  const finais = new Set(estado.map(chave));
  const iniciais = new Set(originais.map(chave));
  const excluir = originais.filter((r) => !finais.has(chave(r)));
  const incluir = estado.filter((r) => !iniciais.has(chave(r)));
  return { excluir, incluir };
}
