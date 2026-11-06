import { validarDataNaJanela, validarHorarioEspecial, obterExpedienteEspecialDezembro2026 } from "./agendamentoRegras.mjs";
import { atendimentosConflitamComBuffer } from "./agendaBuffer.mjs";
function horarioInvalido(motivo) {
  return { valido: false, motivo };
}

export function validarHorarioPix(dataIso, horario, duracao, agora = new Date(), opcoes = {}) {
  if (
    typeof dataIso !== "string" ||
    typeof horario !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dataIso) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)
  ) {
    return horarioInvalido("Data ou horario invalido");
  }

  const [ano, mes, dia] = dataIso.split("-").map(Number);

  if (ano < 2000 || ano > 2100) {
    return horarioInvalido("Data invalida");
  }

  const data = new Date(Date.UTC(ano, mes - 1, dia, 12));

  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia
  ) {
    return horarioInvalido("Data inexistente");
  }

  const validacaoData = validarDataNaJanela(dataIso, agora);
  if (!validacaoData.valido) return horarioInvalido(validacaoData.motivo);

  if (!Number.isSafeInteger(duracao) || duracao <= 0 || duracao > 600) {
    return horarioInvalido("Duracao invalida");
  }

  const [horas, minutos] = horario.split(":").map(Number);

  const inicio = horas * 60 + minutos;
  const fim = inicio + duracao;
  // Grade nativa: :00, :15, :30 e :45 são horários normais.
  // Conflitos/buffer continuam revalidados no banco sob lock de data.
  const gradeValida = inicio % 15 === 0;
  const diaSemana = data.getUTCDay();

  const especial = obterExpedienteEspecialDezembro2026(dataIso);
  // Datas fechadas permanecem indisponíveis, inclusive domingos e feriados.
  if (especial && !especial.aberto) return horarioInvalido("Dia sem atendimento");
  if (!especial && (diaSemana === 0 || diaSemana === 1)) {
    return horarioInvalido("Dia sem atendimento");
  }

  const horarioEstendido = diaSemana === 4 || diaSemana === 5;
  const sabado = diaSemana === 6;
  const abertura = especial?.inicioMinuto ?? (diaSemana === 4 ? 660 : 540);
  // Encerramento é a hora final do serviço, não seu último horário de início.
  const fechamento = especial?.encerramentoMinuto
    ?? (sabado ? 1110 : horarioEstendido ? 1260 : 1200);
  const ultimoInicio = fechamento - 15;
  if (inicio < abertura || inicio > ultimoInicio || !gradeValida || fim > fechamento) {
    return horarioInvalido("Fora do horario permitido");
  }

  // Horários semanais e exceções por data compartilhados com o frontend.
  if (!validarHorarioEspecial(dataIso, horario, duracao)) {
    return horarioInvalido("Horário ou duração indisponível neste expediente");
  }
  // Campo legado preservado para consumidores existentes.
  return { valido: true, inicioMinuto: inicio, fimMinuto: fim, encaixeInteligente: false };

}

export function possuiSobreposicao(inicio, fim, intervalos, buffer = 0) {
  if (!Array.isArray(intervalos)) {
    throw new TypeError("Lista de intervalos invalida");
  }

  return intervalos.some(
    (ocupado) => atendimentosConflitamComBuffer(
      inicio, fim, ocupado.inicioMinuto, ocupado.fimMinuto, buffer,
    ),
  );
}

