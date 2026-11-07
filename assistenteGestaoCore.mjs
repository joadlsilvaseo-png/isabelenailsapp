/**
 * Assistente Isabele: regras determinísticas de gestão.
 * Somente cálculos de leitura. Não cria, altera ou bloqueia agendamentos.
 * Nenhum dado pessoal é persistido em cache local.
 */
import { DIAS_SUGESTAO_MANUTENCAO, ehAplicacaoDeGel } from "./perfilManutencao.mjs";

const ATIVOS = new Set(["agendado", "confirmado", "reagendado"]);
const CONCLUIDOS = new Set(["concluido", "realizado"]);
const PADRAO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const PADRAO_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

function primeiro(dados, campos, fallback = "") {
  for (const campo of campos) {
    const valor = dados?.[campo];
    if (valor !== null && valor !== undefined && String(valor).trim() !== "") return valor;
  }
  return fallback;
}

function texto(valor) {
  return String(valor ?? "").trim();
}

function statusDe(registro) {
  const valor = texto(registro.status).toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");
  if (ATIVOS.has(valor)) return "ativo";
  if (CONCLUIDOS.has(valor)) return "concluido";
  if (valor.startsWith("cancelado") || valor.startsWith("cancelled")) return "cancelado";
  return "outro";
}

function minutos(horario) {
  if (!PADRAO_HORA.test(texto(horario))) return null;
  const [hora, minuto] = horario.split(":").map(Number);
  return hora * 60 + minuto;
}

function validoISO(iso) {
  if (!PADRAO_DATA.test(iso)) return false;
  const [ano, mes, dia] = iso.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

export function adicionarDiasISO(iso, dias) {
  if (!validoISO(iso) || !Number.isInteger(dias)) return null;
  const [ano, mes, dia] = iso.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia + dias));
  return data.toISOString().slice(0, 10);
}

export function diferencaDiasISO(inicio, fim) {
  if (!validoISO(inicio) || !validoISO(fim)) return null;
  const ms = (iso) => Date.UTC(...iso.split("-").map((v, i) => Number(v) - (i === 1 ? 1 : 0)));
  return Math.round((ms(fim) - ms(inicio)) / 86400000);
}

function numeroMonetario(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "number") return Number.isFinite(valor) && valor >= 0 ? valor : null;
  let numero = texto(valor).replace(/R\$/gi, "").replace(/\s/g, "");
  if (numero.includes(",")) numero = numero.replace(/\./g, "").replace(",", ".");
  const n = Number(numero);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function padronizarAgendamentos(registros) {
  return (Array.isArray(registros) ? registros : []).map((registro) => {
    const data = texto(primeiro(registro, ["data", "dataAgendamento", "date"]));
    const horario = texto(primeiro(registro, ["horario", "hora", "time"]));
    const duracao = Number(primeiro(registro, ["duracaoSnapshot", "duracao", "duracaoMinutos"], 0));
    return {
      id: texto(registro?.id),
      clienteId: texto(primeiro(registro, ["clienteId", "idCliente", "uidCliente", "userId", "usuarioId"])),
      nomeCliente: texto(primeiro(registro, ["nomeCliente", "clienteNome", "nome"], "Cliente")),
      servico: texto(primeiro(registro, ["servico", "nomeServico", "servicoNome"])),
      categoria: texto(primeiro(registro, ["categoria", "categoriaNome"])),
      data: validoISO(data) ? data : "",
      horario: minutos(horario) === null ? "" : horario,
      duracao: Number.isInteger(duracao) && duracao > 0 && duracao <= 1440 ? duracao : 0,
      valor: numeroMonetario(primeiro(registro, ["valorFinal", "precoSnapshot", "valor", "preco"], null)),
      status: statusDe(registro),
    };
  }).filter((a) => a.data);
}

function clientesPorId(clientes) {
  const mapa = new Map();
  for (const item of Array.isArray(clientes) ? clientes : []) {
    if (typeof item?.id !== "string" || !item.id) continue;
    mapa.set(item.id, {
      id: item.id,
      nome: texto(primeiro(item, ["nome", "nomeCliente", "name"], "Cliente")),
      telefone: texto(primeiro(item, ["telefone", "celular", "whatsapp", "phone"])),
    });
  }
  return mapa;
}

/**
 * Calcula as janelas restantes do DIA. A consulta PIX também representa
 * reservas pendentes e bloqueios; não contamos intervalos sobrepostos em dobro.
 * null = API de disponibilidade indisponível (nunca estimar horário livre).
 */
export function minutosLivresRestantes({ janelas, ocupacoes, agoraMinuto, intervalosPix }) {
  if (!Array.isArray(janelas) || !janelas.length) return 0;
  if (!Array.isArray(intervalosPix)) return null;
  const periodos = [...(Array.isArray(ocupacoes) ? ocupacoes : []), ...intervalosPix]
    .map((p) => ({ inicioMinuto: Number(p.inicioMinuto), fimMinuto: Number(p.fimMinuto) }))
    .filter((p) => Number.isInteger(p.inicioMinuto) && Number.isInteger(p.fimMinuto)
      && p.inicioMinuto >= 0 && p.fimMinuto <= 1440 && p.fimMinuto > p.inicioMinuto);
  let livres = 0;
  for (const janela of janelas) {
    const inicio = Math.max(Number(janela.inicioMinuto), Number.isInteger(agoraMinuto) ? agoraMinuto : 0);
    const fim = Number(janela.encerramentoMinuto);
    if (!Number.isInteger(inicio) || !Number.isInteger(fim) || fim <= inicio) continue;
    const ocupadas = periodos.map((p) => ({
      inicio: Math.max(inicio, p.inicioMinuto),
      fim: Math.min(fim, p.fimMinuto),
    })).filter((p) => p.fim > p.inicio).sort((a, b) => a.inicio - b.inicio);
    let cursor = inicio;
    for (const intervalo of ocupadas) {
      if (intervalo.inicio > cursor) livres += intervalo.inicio - cursor;
      cursor = Math.max(cursor, intervalo.fim);
    }
    livres += Math.max(0, fim - cursor);
  }
  return livres;
}

function montarResumo(agendamentos, hoje, horarioAtual, janelas, intervalosPix) {
  const compromissos = agendamentos.filter((a) => a.data === hoje && (a.status === "ativo" || a.status === "concluido"));
  const agoraMinuto = minutos(horarioAtual);
  const ocupacoes = compromissos.filter((a) => a.horario && a.duracao).map((a) => {
    const inicioMinuto = minutos(a.horario);
    return { inicioMinuto, fimMinuto: inicioMinuto + a.duracao };
  });
  const proximos = compromissos.filter((a) => a.status === "ativo" && a.horario
    && (agoraMinuto === null || minutos(a.horario) >= agoraMinuto))
    .sort((a, b) => a.horario.localeCompare(b.horario));
  return {
    atendimentos: compromissos.length,
    duracaoReservada: compromissos.reduce((acc, a) => acc + a.duracao, 0),
    tempoLivreRestante: minutosLivresRestantes({ janelas, ocupacoes, agoraMinuto, intervalosPix }),
    proximo: proximos[0] || null,
    diaComExpediente: Array.isArray(janelas) && janelas.length > 0,
  };
}

function montarRadar(agendamentos, clientes, hoje) {
  const finalizados = new Map();
  const futuros = new Set();
  for (const a of agendamentos) {
    if (!a.clienteId) continue;
    if (a.status === "ativo" && a.data >= hoje) futuros.add(a.clienteId);
    if (a.status !== "concluido" || a.data > hoje) continue;
    const lista = finalizados.get(a.clienteId) || [];
    lista.push(a);
    finalizados.set(a.clienteId, lista);
  }

  const candidatos = [];
  for (const [uid, lista] of finalizados) {
    if (futuros.has(uid)) continue;
    lista.sort((a, b) => b.data.localeCompare(a.data) || b.horario.localeCompare(a.horario));
    const ultimo = lista[0];
    let intervalo = null;
    let criterio = "";
    if (ehAplicacaoDeGel({ nome: ultimo.servico, categoria: ultimo.categoria })) {
      intervalo = DIAS_SUGESTAO_MANUTENCAO;
      criterio = "Manutenção sugerida após aplicação de gel";
    } else if (lista.length > 1) {
      // Periodicidade só é inferida com ao menos duas visitas concluídas.
      const gap = diferencaDiasISO(lista[1].data, ultimo.data);
      if (gap !== null && gap >= 14 && gap <= 90) {
        intervalo = gap;
        criterio = "Intervalo observado entre as duas últimas visitas";
      }
    }
    if (intervalo === null) continue;
    const dataSugerida = adicionarDiasISO(ultimo.data, intervalo);
    const diasParaRetorno = diferencaDiasISO(hoje, dataSugerida);
    // Não classificar histórico muito antigo como oportunidade atual.
    if (diasParaRetorno < -60 || diasParaRetorno > 7) continue;
    const cliente = clientes.get(uid);
    candidatos.push({
      uid,
      nome: cliente?.nome || ultimo.nomeCliente,
      telefone: cliente?.telefone || "",
      servico: ultimo.servico,
      ultimaVisita: ultimo.data,
      dataSugerida,
      diasParaRetorno,
      criterio,
    });
  }
  return candidatos.sort((a, b) => a.diasParaRetorno - b.diasParaRetorno
    || a.nome.localeCompare(b.nome, "pt-BR")).slice(0, 30);
}

function montarSemana(agendamentos, hoje) {
  const atualInicio = adicionarDiasISO(hoje, -6);
  const anteriorInicio = adicionarDiasISO(hoje, -13);
  const anteriorFim = adicionarDiasISO(hoje, -7);
  const calcular = (inicio, fim) => {
    const doPeriodo = agendamentos.filter((a) => a.data >= inicio && a.data <= fim);
    const concluidos = doPeriodo.filter((a) => a.status === "concluido");
    const cancelados = doPeriodo.filter((a) => a.status === "cancelado");
    const valoresInformados = concluidos.every((a) => a.valor !== null);
    const receita = valoresInformados
      ? concluidos.reduce((soma, a) => soma + a.valor, 0) : null;
    const servicos = new Map();
    for (const a of concluidos) {
      if (a.servico) servicos.set(a.servico, (servicos.get(a.servico) || 0) + 1);
    }
    const maisFrequente = [...servicos].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { concluidos: concluidos.length, cancelados: cancelados.length, receitaEstimada: receita, maisFrequente };
  };
  return {
    atual: calcular(atualInicio, hoje),
    anterior: calcular(anteriorInicio, anteriorFim),
    atualInicio, anteriorInicio, anteriorFim, hoje,
    // Intervalos móveis equivalentes de sete dias; não confundir com semana civil.
    periodo: "últimos 7 dias",
  };
}

function recomendar({ resumo, radar, semana }) {
  const itens = [];
  const vencidas = radar.filter((c) => c.diasParaRetorno <= 0);
  if (vencidas.length) itens.push({
    tipo: "retorno", prioridade: 90,
    titulo: "Clientes para retorno",
    descricao: vencidas.length === 1
      ? "Uma cliente chegou ao período recomendado de retorno e não tem agendamento futuro."
      : vencidas.length + " clientes chegaram ao período recomendado de retorno e não têm agendamento futuro.",
    link: "#ig-radar",
    acao: "Ver clientes",
  });

  if (semana.anterior.concluidos >= 2 && semana.atual.concluidos < semana.anterior.concluidos) itens.push({
    tipo: "semanal", prioridade: 78,
    titulo: "Movimento da semana",
    descricao: "Nos últimos 7 dias, foram " + semana.atual.concluidos
      + " atendimentos concluídos, contra " + semana.anterior.concluidos
      + " nos 7 dias anteriores. Confira os indicadores.",
    link: "#ig-semana", acao: "Analisar semana",
  });
  if (!vencidas.length && radar.length) itens.push({
    tipo: "retorno", prioridade: 67,
    titulo: "Próximas manutenções",
    descricao: radar.length + (radar.length === 1 ? " cliente está" : " clientes estão")
      + " próxima(s) da data sugerida de retorno, sem novos agendamentos.",
    link: "#ig-radar", acao: "Ver oportunidades",
  });
  if (radar.length) itens.push({
    tipo: "mensagem", prioridade: vencidas.length ? 71 : 59,
    titulo: "Mensagens personalizadas",
    descricao: "Prepare convites de retorno para revisão e envio manual pelo WhatsApp.",
    link: "#ig-radar", acao: "Preparar mensagens",
  });
  if (resumo.diaComExpediente && resumo.atendimentos === 0) itens.push({
    tipo: "dia", prioridade: 55,
    titulo: "Agenda sem atendimentos hoje",
    descricao: "Não há atendimentos ativos ou concluídos registrados para hoje. Confira a agenda antes de divulgar horários.",
    link: "./admin-agendamentos.html", acao: "Conferir agenda",
  });
  if (semana.atual.concluidos > semana.anterior.concluidos) itens.push({
    tipo: "semanal", prioridade: 40,
    titulo: "Boa evolução na semana",
    descricao: "O número de atendimentos concluídos cresceu em relação aos sete dias anteriores.",
    link: "#ig-semana", acao: "Ver análise semanal",
  });
  if (!itens.length) itens.push({
    tipo: "resumo", prioridade: 10,
    titulo: "Sua gestão está em dia",
    descricao: "Nenhuma ação prioritária foi identificada com os dados disponíveis. Confira a agenda e o resumo semanal.",
    link: "#ig-semana", acao: "Ver detalhes",
  });
  return itens.sort((a, b) => b.prioridade - a.prioridade);
}

export function montarVisaoGestao({ agendamentos, clientes, hoje, horarioAtual, janelas = [], intervalosPix = null }) {
  if (!validoISO(hoje)) throw new TypeError("Data inválida para o Assistente Isabele.");
  const normalizados = padronizarAgendamentos(agendamentos);
  const resumo = montarResumo(normalizados, hoje, horarioAtual, janelas, intervalosPix);
  const radar = montarRadar(normalizados, clientesPorId(clientes), hoje);
  const semana = montarSemana(normalizados, hoje);
  return { hoje, resumo, radar, semana, recomendacoes: recomendar({ resumo, radar, semana }) };
}

export function formatarDuracao(minutosValor) {
  if (!Number.isInteger(minutosValor) || minutosValor < 0) return "—";
  const h = Math.floor(minutosValor / 60), m = minutosValor % 60;
  return h ? h + "h" + (m ? String(m).padStart(2, "0") : "") : m + " min";
}

export function formatarDataBR(iso) {
  return validoISO(iso) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—";
}

export function mensagemRetorno(cliente) {
  const primeiroNome = texto(cliente?.nome).split(/\s+/)[0] || "menina";
  const assunto = cliente?.criterio === "Manutenção sugerida após aplicação de gel"
    ? "sua próxima manutenção" : "seu próximo atendimento";
  return "Olá, " + primeiroNome + "! Tudo bem? 💗 Aqui é a Isabele Mariana Nails. "
    + "Passando para saber se você gostaria de agendar " + assunto
    + ". Se quiser, posso te ajudar a encontrar um horário. ✨";
}

export function linkWhatsApp(telefone, mensagem) {
  let numero = texto(telefone).replace(/\D/g, "");
  if (numero.length === 10 || numero.length === 11) numero = "55" + numero;
  if (!/^55\d{10,11}$/.test(numero)) return null;
  return "https://wa.me/" + numero + "?text=" + encodeURIComponent(mensagem);
}
