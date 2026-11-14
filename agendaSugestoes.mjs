/**
 * Motor de sugestões: classifica apenas horários potenciais obtidos do Firestore.
 * Não confirma disponibilidade nem substitui a validação PIX/bloqueios.
 */
import { obterJanelasAtendimento, validarHorarioEspecial, validarServicoDezembro2026 } from "./infra/backend/src/agendamentoRegras.mjs";
import { indisponivelComBufferSequencial } from "./infra/backend/src/agendaBuffer.mjs";

const STATUS_ATIVOS = new Set(["agendado", "reagendado", "confirmado"]);
const HORA_VALIDA = /^([01]\d|2[0-3]):[0-5]\d$/;

function emMinutos(hora) {
  if (typeof hora !== "string" || !HORA_VALIDA.test(hora)) return null;
  const [h, m] = hora.split(":").map(Number);
  return h * 60 + m;
}

function horaDe(minutos) {
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

function diaUTC(dataIso) {
  if (typeof dataIso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) return null;
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  const valor = Date.UTC(ano, mes - 1, dia);
  const data = new Date(valor);
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 &&
    data.getUTCDate() === dia ? valor : null;
}

/** Sete dias corridos, incluindo hoje; nunca inventar dias fora do calendário. */
export function escolherDiasSemana(datas, hoje) {
  const origem = diaUTC(hoje);
  if (!Array.isArray(datas) || origem === null) return [];
  const vistos = new Set();
  return datas.filter((dataIso) => {
    const data = diaUTC(dataIso);
    if (data === null || data < origem || data >= origem + 7 * 86400000 ||
        vistos.has(dataIso)) return false;
    vistos.add(dataIso);
    return true;
  }).sort();
}

function ocupacoesDia(agendamentos, dataIso, clienteId) {
  if (!Array.isArray(agendamentos)) return [];
  return agendamentos.flatMap((item) => {
    if (item?.data !== dataIso || !STATUS_ATIVOS.has(item.status)) return [];
    const inicio = emMinutos(item.horario);
    const duracao = Number(item.duracao) || 90; // Mesma duração de fallback do agendamento atual.
    if (inicio === null || !Number.isFinite(duracao) || duracao <= 0) return [];
    return [{
      inicioMinuto: inicio, fimMinuto: inicio + duracao, tipo: "agendamento",
      ...(clienteId && item.clienteId === clienteId ? { sequencialMesmaCliente: true } : {}),
    }];
  });
}

function pontuar(inicio, fim, ocupacoes) {
  const anteriores = ocupacoes.filter((item) => item.fimMinuto <= inicio);
  const posteriores = ocupacoes.filter((item) => item.inicioMinuto >= fim);
  const anterior = anteriores.length
    ? Math.max(...anteriores.map((item) => item.fimMinuto)) : null;
  const proximo = posteriores.length
    ? Math.min(...posteriores.map((item) => item.inicioMinuto)) : null;
  const antes = anterior === null ? null : inicio - anterior;
  const depois = proximo === null ? null : proximo - fim;
  let pontos = 0;
  // Prioridade principal: iniciar 15 minutos depois do atendimento anterior.
  if (antes === 15) pontos += 1200;
  else if (antes === 0) pontos += 950; // Exceção já existente: mesma cliente.
  else if (antes !== null && antes < 120) pontos += Math.max(0, 400 - antes * 3);
  // Também aproveitar bem o espaço antes do próximo atendimento.
  if (depois === 0) pontos += 650;
  else if (depois === 15) pontos += 450;
  else if (depois !== null && depois < 120) pontos += Math.max(0, 250 - depois * 2);
  if (antes !== null && depois !== null) pontos += 100;
  return pontos;
}

/**
 * Sugestões são apenas indicativas. O clique obrigatoriamente usa o fluxo de
 * disponibilidade já existente, que incorpora reservas PIX e bloqueios.
 */
export function sugerirHorarios({
  datas, agendamentos, duracao, servico, hoje, inicioPeriodo = hoje, minutoAtual = null,
  clienteId = null, maxPorDia = 2,
}) {
  const minutosServico = Number(duracao);
  if (!Number.isInteger(minutosServico) || minutosServico <= 0 ||
      minutosServico > 600 || !Array.isArray(agendamentos)) return [];
  const limite = Number.isInteger(maxPorDia) ? Math.max(1, Math.min(3, maxPorDia)) : 2;
  const resultado = [];
  for (const dataIso of escolherDiasSemana(datas, inicioPeriodo)) {
    if (!validarServicoDezembro2026(dataIso, servico).valido) continue;
    const janelas = obterJanelasAtendimento(dataIso);
    if (!janelas.length) continue;
    const ocupacoes = ocupacoesDia(agendamentos, dataIso, clienteId);
    const opcoes = [];
    for (const { inicioMinuto, encerramentoMinuto } of janelas) {
      for (let minuto = inicioMinuto; minuto <= encerramentoMinuto - 15; minuto += 15) {
        if (dataIso === hoje && Number.isInteger(minutoAtual) && minuto <= minutoAtual) continue;
        const horario = horaDe(minuto);
        if (!validarHorarioEspecial(dataIso, horario, minutosServico)) continue;
        const fim = minuto + minutosServico;
        if (indisponivelComBufferSequencial(minuto, fim, ocupacoes)) continue;
        opcoes.push({ horario, pontos: pontuar(minuto, fim, ocupacoes), minuto });
      }
    }
    opcoes.sort((a, b) => b.pontos - a.pontos || a.minuto - b.minuto);
    if (opcoes.length) resultado.push({
      dataIso,
      horarios: opcoes.slice(0, limite).map(({ horario }) => horario),
    });
  }
  return resultado;
}
