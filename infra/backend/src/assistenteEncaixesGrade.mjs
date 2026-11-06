import { obterJanelasAtendimento, validarHorarioEspecial, validarServicoDezembro2026 } from "./agendamentoRegras.mjs";

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

function obterHoraCivil(agora) {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(agora);
  const mapa = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return Number(mapa.hour) * 60 + Number(mapa.minute);
}

function normalizarBaixaProcura(valor) {
  return String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function servicoDeBaixaProcura(servico) {
  return servico.baixaProcura === true || normalizarBaixaProcura(servico.nome) === "remocao de gel";
}

function obterPeriodosOcupados({ agendamentos, reservas, bloqueios }) {
  const periodos = [...agendamentos, ...reservas, ...bloqueios]
    .filter(intervaloValido)
    .map(({ inicioMinuto, fimMinuto }) => ({ inicioMinuto, fimMinuto }))
    .sort((a, b) => a.inicioMinuto - b.inicioMinuto || a.fimMinuto - b.fimMinuto);
  const unidos = [];
  for (const periodo of periodos) {
    const anterior = unidos.at(-1);
    if (!anterior || periodo.inicioMinuto > anterior.fimMinuto) unidos.push({ ...periodo });
    else anterior.fimMinuto = Math.max(anterior.fimMinuto, periodo.fimMinuto);
  }
  return unidos;
}

function servicosQueCabem({ data, inicio, fim, servicos, horaAtual, hoje }) {
  return servicos.filter((servico) => {
    if (!validarServicoDezembro2026(data, servico).valido) return false;
    for (let inicioServico = Math.ceil(inicio / GRADE) * GRADE;
      inicioServico + servico.duracaoMinutos <= fim; inicioServico += GRADE) {
      if (hoje === data && inicioServico <= horaAtual) continue;
      if (validarHorarioEspecial(data, formatarMinutos(inicioServico), servico.duracaoMinutos)) return true;
    }
    return false;
  });
}

/**
 * Analisa apenas lacunas entre períodos ocupados. As sugestões nunca reservam nem
 * alteram a agenda; a disponibilidade real continua sendo validada pelo fluxo normal.
 */
export function analisarLacunasDoDia({
  data, agendamentos = [], reservas = [], bloqueios = [], servicos = [],
  hoje = null, agora = new Date(),
}) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new TypeError("Data inválida");
  if (![agendamentos, reservas, bloqueios, servicos].every(Array.isArray)) throw new TypeError("Coleções inválidas");
  for (const item of [...agendamentos, ...reservas, ...bloqueios]) {
    if (!intervaloValido(item)) throw new TypeError("Intervalo inválido na agenda");
  }
  if (hoje && data < hoje) return [];
  const janelas = obterJanelasAtendimento(data);
  if (!janelas.length) return [];
  const ativos = obterPeriodosOcupados({ agendamentos, reservas, bloqueios });
  if (ativos.length < 2) return [];
  const servicosValidos = servicos.filter((s) => s && typeof s.id === "string" &&
    typeof s.nome === "string" && Number.isInteger(s.duracaoMinutos) &&
    s.duracaoMinutos > 0 && s.duracaoMinutos <= 600);
  const horaAtual = hoje === data ? obterHoraCivil(agora) : -1;
  const sugestoes = [];

  for (let i = 1; i < ativos.length; i++) {
    const inicioLacuna = ativos[i - 1].fimMinuto;
    const fimLacuna = ativos[i].inicioMinuto;
    const primeiroInicioFuturo = hoje === data ? (Math.floor(horaAtual / GRADE) + 1) * GRADE : inicioLacuna;
    const inicioAnalisado = Math.max(inicioLacuna, primeiroInicioFuturo);
    const duracaoLacunaMinutos = fimLacuna - inicioAnalisado;
    if (duracaoLacunaMinutos <= 0) continue;
    const elegiveis = servicosQueCabem({
      data, inicio: inicioAnalisado, fim: fimLacuna, servicos: servicosValidos, horaAtual, hoje,
    });
    const baixaProcura = elegiveis.filter(servicoDeBaixaProcura);
    const normais = elegiveis.filter((servico) => !servicoDeBaixaProcura(servico));

    let classificacao = null;
    let justificativa = "";
    if (duracaoLacunaMinutos === 15) {
      if (!elegiveis.length) {
        classificacao = "sugestao_bloqueio";
        justificativa = "A lacuna de 15 minutos não comporta nenhum serviço ativo permitido.";
      }
    } else if (duracaoLacunaMinutos === 30) {
      classificacao = "sugestao_bloqueio";
      justificativa = baixaProcura.length
        ? "Este horário é utilizável por serviço curto, mas há opção de baixa procura; avalie se vale mantê-lo aberto."
        : "Lacuna de 30 minutos: avalie se vale manter este intervalo curto aberto.";
    } else if (duracaoLacunaMinutos === 45) {
      if (!elegiveis.length) {
        classificacao = "sugestao_bloqueio";
        justificativa = "A lacuna de 45 minutos não comporta nenhum serviço ativo permitido.";
      } else if (!normais.length) {
        classificacao = "sugestao_bloqueio";
        justificativa = "O intervalo é utilizável por serviço curto de baixa procura; avalie a conveniência de mantê-lo aberto.";
      }
    } else if (duracaoLacunaMinutos > 45 && !elegiveis.length) {
      classificacao = "sugestao_bloqueio";
      justificativa = "Nenhum serviço ativo permitido cabe neste intervalo.";
    }
    if (!classificacao) continue;
    sugestoes.push({
      chave: `${data}:${inicioAnalisado}:${fimLacuna}`,
      data,
      inicio: formatarMinutos(inicioAnalisado),
      fim: formatarMinutos(fimLacuna),
      duracaoLacunaMinutos,
      classificacao,
      justificativa,
      servicosElegiveis: elegiveis.map((servico) => ({ id: servico.id, nome: servico.nome, duracaoMinutos: servico.duracaoMinutos })),
      ...(baixaProcura.length ? { contemServicoBaixaProcura: true } : {}),
      opcoes: [],
    });
  }
  return sugestoes;
}
