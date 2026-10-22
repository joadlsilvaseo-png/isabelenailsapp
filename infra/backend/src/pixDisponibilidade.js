import { validarDataNaJanela, validarHorarioEspecial } from "./agendamentoRegras.mjs";
function horarioInvalido(motivo) {
  return { valido: false, motivo };
}

export function validarHorarioPix(dataIso, horario, duracao, agora = new Date()) {
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
  const diaSemana = data.getUTCDay();

  // Atendimento permitido somente de terça a sábado.
  if (diaSemana === 0 || diaSemana === 1) {
    return horarioInvalido("Dia sem atendimento");
  }

  const horarioEstendido = diaSemana === 4 || diaSemana === 5;
  const sabado = diaSemana === 6;
  const abertura = diaSemana === 4 ? 660 : 540;
  const ultimoInicio = sabado ? 960 : horarioEstendido ? 1140 : 1080;
  const fechamento = sabado ? 1440 : horarioEstendido ? 1260 : 1200;
  if (inicio < abertura || inicio > ultimoInicio || inicio % 30 !== 0 || fim > fechamento) {
    return horarioInvalido("Fora do horario permitido");
  }

  // Pausa de 30 minutos: qualquer servico que toque 13h30-14h fica indisponivel.
  // Terminar exatamente as 13h30 ou iniciar as 14h e permitido.
  if (inicio < 14 * 60 && fim > 13 * 60 + 30) {
    return horarioInvalido("Intervalo de almoco indisponivel");
  }

  if (!validarHorarioEspecial(dataIso, horario, duracao)) {
    return horarioInvalido(diaSemana === 2 ? "Horario indisponivel na terca" : "Horario indisponivel na quarta");
  }

  return {
    valido: true,
    inicioMinuto: inicio,
    fimMinuto: fim,
  };
}

export function possuiSobreposicao(inicio, fim, intervalos) {
  if (!Array.isArray(intervalos)) {
    throw new TypeError("Lista de intervalos invalida");
  }

  return intervalos.some(
    (ocupado) => inicio < ocupado.fimMinuto && fim > ocupado.inicioMinuto,
  );
}

