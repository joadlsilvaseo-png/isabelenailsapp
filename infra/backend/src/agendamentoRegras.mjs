const AGENDA_INICIO_ISO = "2026-11-01";
const DATAS_DEZEMBRO_LIBERADAS = new Set();

function partesDataISO(dataIso) {
  if (typeof dataIso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) return null;
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia, 12));
  if (data.getUTCFullYear() !== ano || data.getUTCMonth() !== mes - 1 || data.getUTCDate() !== dia) return null;
  return { ano, mes, dia, data };
}

export function obterHojeSaoPaulo(agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(agora);
  const valores = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

export function adicionarMesCalendario(dataIso, meses = 1) {
  const partes = partesDataISO(dataIso);
  if (!partes || !Number.isInteger(meses)) throw new TypeError("Data ou quantidade de meses inválida.");
  const indiceMes = partes.mes - 1 + meses;
  const ano = partes.ano + Math.floor(indiceMes / 12);
  const mesZero = ((indiceMes % 12) + 12) % 12;
  const ultimoDia = new Date(Date.UTC(ano, mesZero + 1, 0)).getUTCDate();
  const dia = Math.min(partes.dia, ultimoDia);
  return `${ano}-${String(mesZero + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export function obterJanelaAgendamento(agora = new Date()) {
  const hoje = obterHojeSaoPaulo(agora);
  return {
    inicio: hoje < AGENDA_INICIO_ISO ? AGENDA_INICIO_ISO : hoje,
    fim: adicionarMesCalendario(hoje, 1),
  };
}

export function validarDataNaJanela(dataIso, agora = new Date()) {
  const partes = partesDataISO(dataIso);
  if (!partes) return { valido: false, motivo: "Data inexistente" };
  const janela = obterJanelaAgendamento(agora);
  if (dataIso < janela.inicio || dataIso > janela.fim) return { valido: false, motivo: "Data fora da janela de agendamento" };
  if (partes.ano === 2026 && partes.mes === 12 && !DATAS_DEZEMBRO_LIBERADAS.has(dataIso)) return { valido: false, motivo: "Agenda de dezembro ainda não disponível" };
  return { valido: true, diaSemana: partes.data.getUTCDay(), janela };
}

export function validarHorarioEspecialSemanal(diaSemana, inicioMinuto, duracao) {
  if (!Number.isInteger(inicioMinuto) || !Number.isInteger(duracao) || duracao <= 0) return false;
  const fim = inicioMinuto + duracao;
  if (diaSemana === 2) return [840, 870, 900].includes(inicioMinuto) && fim <= 1050;
  if (diaSemana === 3) return (inicioMinuto === 540 && fim <= 750) || (inicioMinuto === 840 && fim <= 1050);
  return true;
}

export function validarHorarioEspecial(dataIso, horario, duracao) {
  const partes = partesDataISO(dataIso);
  if (!partes || typeof horario !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) return false;
  const [hora, minuto] = horario.split(":").map(Number);
  return validarHorarioEspecialSemanal(partes.data.getUTCDay(), hora * 60 + minuto, Number(duracao));
}
