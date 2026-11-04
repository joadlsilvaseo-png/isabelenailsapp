/**
 * Identifica o mês que ocupa a maior área horizontal visível na roleta.
 * Os retângulos estão na mesma referência de coordenadas do viewport.
 * Não altera qual data foi selecionada para o agendamento.
 */
export function obterMesPredominante(cartoes, inicioVisivel, fimVisivel) {
  if (!Array.isArray(cartoes) || !Number.isFinite(inicioVisivel) ||
      !Number.isFinite(fimVisivel) || fimVisivel <= inicioVisivel) return null;

  const areaPorMes = new Map();
  for (const cartao of cartoes) {
    if (!/^\d{4}-\d{2}$/.test(cartao?.mes || "") ||
        !Number.isFinite(cartao?.inicio) || !Number.isFinite(cartao?.fim)) continue;

    const visivel = Math.max(0,
      Math.min(cartao.fim, fimVisivel) - Math.max(cartao.inicio, inicioVisivel));
    if (visivel > 0) {
      areaPorMes.set(cartao.mes, (areaPorMes.get(cartao.mes) || 0) + visivel);
    }
  }

  let maiorArea = 0;
  let mes = null;
  for (const [chave, area] of areaPorMes) {
    if (area > maiorArea) {
      maiorArea = area;
      mes = chave;
    }
  }
  return mes;
}
