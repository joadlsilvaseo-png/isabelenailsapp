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

/** Janela administrativa independente da janela pública de reservas. */
export function obterMesesGerenciaveis(agora = new Date()) {
  const hoje = obterHojeSaoPaulo(agora);
  const [anoAtual, mesAtual] = hoje.split("-").map(Number);
  return Array.from({ length: 3 }, (_, deslocamento) => {
    const indice = mesAtual - 1 + deslocamento;
    const ano = anoAtual + Math.floor(indice / 12);
    const mesZero = indice % 12;
    const mes = mesZero + 1;
    const primeiroDia = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const ultimoDia = new Date(Date.UTC(ano, mesZero + 1, 0)).getUTCDate();
    return {
      chave: `${ano}-${String(mes).padStart(2, "0")}`,
      ano,
      mes,
      inicio: deslocamento === 0 ? hoje : primeiroDia,
      fim: `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`,
    };
  });
}

/** Valida datas de trabalho apenas para bloqueios administrativos; não libera reservas públicas. */
export function validarDataGerenciavel(dataIso, agora = new Date()) {
  const partes = partesDataISO(dataIso);
  if (!partes) return { valido: false, motivo: "Data inexistente" };
  const hoje = obterHojeSaoPaulo(agora);
  const meses = obterMesesGerenciaveis(agora);
  if (dataIso < hoje) return { valido: false, motivo: "Não é possível gerenciar datas passadas" };
  if (dataIso > meses[2].fim) return { valido: false, motivo: "Data fora da janela administrativa" };
  return {
    valido: true,
    diaSemana: partes.data.getUTCDay(),
    janela: { inicio: hoje, fim: meses[2].fim },
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
  if (diaSemana === 6) {
    if (inicioMinuto < 540 || inicioMinuto > 1020 || inicioMinuto % 30 !== 0 || fim > 1080) return false;
    if (inicioMinuto === 900 || inicioMinuto === 930) return duracao <= 60;
    if (inicioMinuto === 960) return [60, 90, 120].includes(duracao);
    if (inicioMinuto === 990) return duracao === 90;
    if (inicioMinuto === 1020) return duracao <= 60;
  }
  return true;
}

export function validarHorarioEspecial(dataIso, horario, duracao) {
  const partes = partesDataISO(dataIso);
  if (!partes || typeof horario !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) return false;
  const [hora, minuto] = horario.split(":").map(Number);
  return validarHorarioEspecialSemanal(partes.data.getUTCDay(), hora * 60 + minuto, Number(duracao));
}

// Horários de 30 minutos que a administradora pode fechar/reabrir.
// Engloba também partes de serviços já iniciados: na quarta, por exemplo,
// fechar 09:30 bloqueia um atendimento iniciado às 09:00 que avance até 10:00.
// NÃO muda os horários de início disponíveis para as clientes.
export function listarSlotsGerenciaveis(dataIso, agora = new Date()) {
  const validacao = validarDataGerenciavel(dataIso, agora);
  if (!validacao.valido) return [];
  const dia = validacao.diaSemana;
  if (dia === 0 || dia === 1) return [];
  const limites = {
    2: [[840, 1050]],                   // Terça: 14:00–17:30.
    3: [[540, 750], [840, 1050]],      // Quarta: manhã e tarde.
    4: [[660, 1140]],                  // Quinta: 11:00–19:00.
    5: [[540, 1140]],                  // Sexta: 09:00–19:00.
    6: [[540, 1080]],                  // Sábado: 09:00–18:00, com regras de duração.
  };
  const slots = [];
  for (const [inicio, fim] of limites[dia] || []) {
    for (let minuto = inicio; minuto + 30 <= fim; minuto += 30) {
      // Pausa fixa em dias úteis; sábado permite 13h30 normalmente.
      if (dia !== 6 && minuto === 810) continue;
      slots.push(minuto);
    }
  }
  return slots;
}
