import { atendimentosConflitamComBuffer } from "./agendaBuffer.mjs";
import { obterJanelasAtendimento, validarHorarioEspecial, validarServicoDezembro2026 } from "./agendamentoRegras.mjs";

const BUFFER = 15;
const GRADE = 15;

export function paraMinutos(horario) {
  if (typeof horario !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
    throw new TypeError("Horário inválido para o assistente");
  }
  const [hora, minuto] = horario.split(":").map(Number);
  return hora * 60 + minuto;
}

export function formatarMinutos(minutos) {
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

function intervaloValido(valor) {
  return Number.isInteger(valor?.inicioMinuto) && Number.isInteger(valor?.fimMinuto) &&
    valor.inicioMinuto >= 0 && valor.fimMinuto <= 1440 && valor.fimMinuto > valor.inicioMinuto;
}

function haSobreposicao(inicio, fim, intervalo) {
  return inicio < intervalo.fimMinuto && fim > intervalo.inicioMinuto;
}

function obterHoraCivil(agora) {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(agora);
  const mapa = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return Number(mapa.hour) * 60 + Number(mapa.minute);
}

/**
 * Detecta oportunidades de encaixe excepcional, jamais disponibilidade confirmada.
 * Somente lacunas ENTRE dois atendimentos ativos.
 * O serviço cabe fisicamente, mas o início exigiria dispensar um dos buffers.
 * Reservas PIX pendentes conservam o buffer; bloqueios nunca podem ser atravessados.
 */
export function analisarLacunasDoDia({
  data, agendamentos = [], reservas = [], bloqueios = [], servicos = [],
  hoje = null, agora = new Date(),
}) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new TypeError("Data inválida");
  }
  const janelas = obterJanelasAtendimento(data);
  if (!janelas.length) return [];
  if (![agendamentos, reservas, bloqueios, servicos].every(Array.isArray)) {
    throw new TypeError("Coleções inválidas");
  }
  for (const item of [...agendamentos, ...reservas, ...bloqueios]) {
    if (!intervaloValido(item)) throw new TypeError("Intervalo inválido na agenda");
  }

  const ativos = [...agendamentos].sort((a, b) => a.inicioMinuto - b.inicioMinuto);
  for (let i = 1; i < ativos.length; i++) {
    if (ativos[i - 1].fimMinuto > ativos[i].inicioMinuto) {
      throw new Error("Há atendimentos sobrepostos: a análise foi interrompida");
    }
  }

  const servicosValidos = servicos.filter((s) =>
    s && typeof s.id === "string" && typeof s.nome === "string" &&
    Number.isInteger(s.duracaoMinutos) && s.duracaoMinutos >= 30 &&
    s.duracaoMinutos <= 600
  );
  const horariosFuturos = hoje === data ? obterHoraCivil(agora) : -1;
  if (hoje && data < hoje) return [];
  const oportunidades = [];

  for (let i = 1; i < ativos.length; i++) {
    const anterior = ativos[i - 1];
    const posterior = ativos[i];
    const inicioLacuna = anterior.fimMinuto;
    const fimLacuna = posterior.inicioMinuto;
    if (fimLacuna <= inicioLacuna || fimLacuna - inicioLacuna < 30) continue;

    const opcoes = [];
    for (const servico of servicosValidos) {
      if (!validarServicoDezembro2026(data, servico).valido) continue;
      const horarios = [];
      const primeiro = Math.ceil(inicioLacuna / GRADE) * GRADE;
      for (let inicio = primeiro; inicio + servico.duracaoMinutos <= fimLacuna; inicio += GRADE) {
        if (inicio <= horariosFuturos) continue;
        const fim = inicio + servico.duracaoMinutos;
        if (!validarHorarioEspecial(data, formatarMinutos(inicio), servico.duracaoMinutos)) continue;

        // Nunca sugerir sobreposições com atendimentos, reservas financeiras ou bloqueios.
        if (ativos.some((item) => haSobreposicao(inicio, fim, item)) ||
            reservas.some((item) => haSobreposicao(inicio, fim, item)) ||
            bloqueios.some((item) => haSobreposicao(inicio, fim, item))) continue;

        // Nunca reduzir o intervalo de segurança de uma reserva PIX pendente.
        if (reservas.some((item) => atendimentosConflitamComBuffer(
          inicio, fim, item.inicioMinuto, item.fimMinuto, BUFFER,
        ))) continue;

        // Se respeita todos os buffers, já é agendável normalmente: não é oportunidade.
        if (!ativos.some((item) => atendimentosConflitamComBuffer(
          inicio, fim, item.inicioMinuto, item.fimMinuto, BUFFER,
        ))) continue;

        horarios.push(formatarMinutos(inicio));
      }
      if (horarios.length) {
        opcoes.push({
          servicoId: servico.id,
          servico: servico.nome,
          duracaoMinutos: servico.duracaoMinutos,
          horarios,
        });
      }
    }

    if (opcoes.length) {
      oportunidades.push({
        chave: `${data}:${inicioLacuna}:${fimLacuna}`,
        data,
        inicio: formatarMinutos(inicioLacuna),
        fim: formatarMinutos(fimLacuna),
        duracaoLacunaMinutos: fimLacuna - inicioLacuna,
        opcoes,
      });
    }
  }
  return oportunidades;
}
