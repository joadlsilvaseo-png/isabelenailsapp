const FUSO_AGENDA = "America/Sao_Paulo";

function dataISOValida(dataIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataIso))) return false;
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

export function formatarDataBrasil(data = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO_AGENDA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(data);
  const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

export function adicionarMesCalendario(dataIso, quantidade = 1) {
  if (!dataISOValida(dataIso)) {
    throw new TypeError("Data ISO inválida.");
  }
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const primeiroDiaDestino = new Date(Date.UTC(ano, mes - 1 + quantidade, 1));
  const ultimoDiaDestino = new Date(Date.UTC(
    primeiroDiaDestino.getUTCFullYear(),
    primeiroDiaDestino.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  const diaDestino = Math.min(dia, ultimoDiaDestino);
  return `${primeiroDiaDestino.getUTCFullYear()}-${String(primeiroDiaDestino.getUTCMonth() + 1).padStart(2, "0")}-${String(diaDestino).padStart(2, "0")}`;
}

export function calcularJanelaMensal(agora = new Date()) {
  const inicio = formatarDataBrasil(agora);
  return { inicio, fim: adicionarMesCalendario(inicio) };
}

export function estaNaJanelaMensal(dataIso, agora = new Date()) {
  if (!dataISOValida(dataIso)) return false;
  const { inicio, fim } = calcularJanelaMensal(agora);
  return dataIso >= inicio && dataIso <= fim;
}
