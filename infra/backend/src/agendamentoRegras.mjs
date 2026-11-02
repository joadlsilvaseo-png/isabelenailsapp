const AGENDA_INICIO_ISO = "2026-11-01";
// Interruptor único de abertura pública. NÃO alterar sem autorização expressa.
export const AGENDA_DEZEMBRO_2026_ABERTA = false;

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
  let fim = adicionarMesCalendario(hoje, 1);
  // Ao abrir oficialmente dezembro, mostrar o mês inteiro a partir de novembro.
  // Com a chave falsa, a janela atual continua absolutamente inalterada.
  if (AGENDA_DEZEMBRO_2026_ABERTA && hoje >= "2026-11-01"
      && hoje <= "2026-12-31" && fim < "2026-12-31") fim = "2026-12-31";
  return {
    inicio: hoje < AGENDA_INICIO_ISO ? AGENDA_INICIO_ISO : hoje,
    fim,
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
  if (partes.ano === 2026 && partes.mes === 12) {
    if (!AGENDA_DEZEMBRO_2026_ABERTA) {
      return { valido: false, motivo: "Agenda de dezembro ainda não disponível" };
    }
    if (obterExpedienteEspecialDezembro2026(dataIso)?.aberto === false) {
      return { valido: false, motivo: "Dia sem atendimento" };
    }
  }
  return { valido: true, diaSemana: partes.data.getUTCDay(), janela };
}

/**
 * Exceções de dezembro/2026, preparadas enquanto a agenda pública permanece fechada.
 * null = manter as regras semanais habituais, inclusive durações específicas.
 * encerramento é o término das atividades, nunca o último início.
 */
const DIAS_FECHADOS_DEZEMBRO = new Set([6, 7, 13, 15, 25, 26, 27, 31]);

export function obterExpedienteEspecialDezembro2026(dataIso) {
  if (typeof dataIso !== "string" || !/^2026-12-\d{2}$/.test(dataIso)) return null;
  const dia = Number(dataIso.slice(-2));
  if (dia < 1 || dia > 31 || DIAS_FECHADOS_DEZEMBRO.has(dia)) {
    return { aberto: false, inicioMinuto: null, encerramentoMinuto: null };
  }
  const expediente = (inicioMinuto, encerramentoMinuto) => ({
    aberto: true, inicioMinuto, encerramentoMinuto,
  });
  if (dia === 14) return expediente(540, 1200);        // Segunda: 09h–20h.
  if (dia === 16) return expediente(780, 1200);        // Quarta: 13h–20h.
  if (dia === 17 || dia === 18) return expediente(540, 1200);
  if (dia >= 19 && dia <= 23) return expediente(420, 1320); // Inclusive domingo e segunda.
  if (dia === 24) return expediente(420, 960);         // Véspera: 07h–16h.
  if (dia >= 28 && dia <= 30) return expediente(540, 1200); // Todos os serviços.
  return null; // Dias restantes até 13/12: regras semanais originais.
}

function normalizarServico(valor) {
  return String(valor ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Verificação comercial pelo cadastro real do serviço, sem alterar o catálogo. */
export function validarServicoDezembro2026(dataIso, servico) {
  if (typeof dataIso !== "string" || !/^2026-12-\d{2}$/.test(dataIso)) {
    return { valido: true };
  }
  const dia = Number(dataIso.slice(-2));
  if (dia < 17 || dia > 24) return { valido: true };
  const nome = normalizarServico(servico?.nome);
  const categoria = normalizarServico(servico?.categoriaNome || servico?.categoria);
  if (!nome) return { valido: false, motivo: "Serviço não identificado para dezembro" };
  const pedicure = /\bpedicure\b/.test(nome) || /\bpedicure\b/.test(categoria);
  const manutencao = /\bmanutencao\b/.test(nome);
  if (dia === 24) {
    const alongamento = /\balongamento\b/.test(nome) && !manutencao && !/\bremocao\b/.test(nome);
    const banhoGel = /\bbanho de gel\b/.test(nome) && !manutencao && !/\bremocao\b/.test(nome);
    const manicureSimples = /\bmanicure simples\b/.test(nome)
      || nome === "manicure" || (categoria === "manicure" && nome === "simples");
    const manicureGel = /\bmanicure em gel\b/.test(nome)
      || ((categoria === "manicure" || /\bmanicure\b/.test(nome))
        && /\besmaltacao em gel\b/.test(nome));
    return !pedicure && !manutencao && (alongamento || banhoGel || manicureSimples || manicureGel)
      ? { valido: true }
      : { valido: false, motivo: "Serviço indisponível no dia 24/12; somente alongamento, banho de gel e manicure simples/em gel" };
  }
  // 17–23: pedicure simples e em gel ficam suspensas; remoções são serviços distintos.
  const pedicureSuspensa = pedicure && !/\bremocao\b/.test(nome)
    && (/\bpedicure\b/.test(nome) || /\bsimples\b/.test(nome)
      || /\bgel\b/.test(nome) || /\besmaltacao\b/.test(nome));
  return pedicureSuspensa
    ? { valido: false, motivo: "Pedicure simples e em gel indisponíveis de 17 a 24/12" }
    : { valido: true };
}

export function validarHorarioEspecialSemanal(diaSemana, inicioMinuto, duracao) {
  if (!Number.isInteger(inicioMinuto) || !Number.isInteger(duracao) || duracao <= 0) return false;
  const fim = inicioMinuto + duracao;
  if (diaSemana === 2) return [840, 870, 900].includes(inicioMinuto) && fim <= 1050;
  if (diaSemana === 3) {
    // Quarta de manhã: janelas comerciais autorizadas, com duração real.
    if (inicioMinuto === 540) return [60, 90, 120, 150].includes(duracao); // 09:00
    if (inicioMinuto === 600) return [60, 90, 120].includes(duracao);      // 10:00
    if (inicioMinuto === 630) return [60, 90].includes(duracao);           // 10:30
    if (inicioMinuto === 660) return duracao <= 60;                         // 11:00
    // À tarde, preserva 14:00 e abre 15:00 apenas para 1h e 1h30.
    if (inicioMinuto === 840) return fim <= 1050;                           // 14:00
    if (inicioMinuto === 900) return [60, 90].includes(duracao);           // 15:00
    return false;
  }
  if (diaSemana === 6) {
    // Exceção única: serviço iniciado às 16h com 150 min termina às 18h30.
    const excecao16h = inicioMinuto === 960 && duracao === 150;
    if (inicioMinuto < 540 || inicioMinuto > 1020 || inicioMinuto % 30 !== 0 || (fim > 1080 && !excecao16h)) return false;
    if (inicioMinuto === 900 || inicioMinuto === 930) return duracao <= 60;
    if (inicioMinuto === 960) return [60, 90, 120, 150].includes(duracao);
    if (inicioMinuto === 990) return duracao === 90;
    if (inicioMinuto === 1020) return duracao <= 60;
  }
  return true;
}

export function validarHorarioEspecial(dataIso, horario, duracao) {
  const partes = partesDataISO(dataIso);
  if (!partes || typeof horario !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) return false;
  const [hora, minuto] = horario.split(":").map(Number);
  const inicioMinuto = hora * 60 + minuto;
  const duracaoMinutos = Number(duracao);
  const especial = obterExpedienteEspecialDezembro2026(dataIso);
  if (especial) {
    return especial.aberto && Number.isInteger(duracaoMinutos) && duracaoMinutos > 0
      && duracaoMinutos <= 600 && inicioMinuto % 30 === 0
      && inicioMinuto >= especial.inicioMinuto
      && inicioMinuto + duracaoMinutos <= especial.encerramentoMinuto;
  }
  return validarHorarioEspecialSemanal(partes.data.getUTCDay(), inicioMinuto, duracaoMinutos);
}

// Horários de 30 minutos que a administradora pode fechar/reabrir.
// Engloba também partes de serviços já iniciados: na quarta, por exemplo,
// fechar 09:30 bloqueia um atendimento iniciado às 09:00 que avance até 10:00.
// NÃO muda os horários de início disponíveis para as clientes.
export function listarSlotsGerenciaveis(dataIso, agora = new Date()) {
  const validacao = validarDataGerenciavel(dataIso, agora);
  if (!validacao.valido) return [];
  const dia = validacao.diaSemana;
  const especial = obterExpedienteEspecialDezembro2026(dataIso);
  if (especial && !especial.aberto) return [];
  if (!especial && (dia === 0 || dia === 1)) return [];
  const limites = {
    2: [[840, 1050]],                   // Terça: 14:00–17:30.
    3: [[540, 750], [840, 1050]],      // Quarta: manhã e tarde.
    4: [[660, 1140]],                  // Quinta: 11:00–19:00.
    5: [[540, 1140]],                  // Sexta: 09:00–19:00.
    6: [[540, 1110]],                  // Sábado: grade de bloqueios cobre a exceção até 18h30.
  };
  const slots = [];
  const periodos = especial ? [[especial.inicioMinuto, especial.encerramentoMinuto]] : (limites[dia] || []);
  for (const [inicio, fim] of periodos) {
    for (let minuto = inicio; minuto + 30 <= fim; minuto += 30) {
      // A administradora pode fechar qualquer intervalo dentro da
      // janela de atendimento, inclusive 13h30–14h quando houver expediente.
      slots.push(minuto);
    }
  }
  return slots;
}
