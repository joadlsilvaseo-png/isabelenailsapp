import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { obterMesesGerenciaveis, listarSlotsGerenciaveis } from "./infra/backend/src/agendamentoRegras.mjs";
import {
  alternarIntervalo,
  agruparIntervalos,
  criarPayloadLote,
  formatarErroCalendario,
  formatarFalhaDeRede,
  iniciarOperacaoCalendario,
  encerrarOperacaoCalendario,
  limparDatasAplicadas,
  obterDataAtiva,
  removerIntervalos,
  resumirSelecoes,
} from "./admin-calendario-state.mjs";

const el = {
  acesso: document.getElementById("calendario-acesso"),
  conteudo: document.getElementById("calendario-main"),
  datas: document.querySelector(".agendamento-calendar"),
  horario: document.querySelector(".agendamento-times"),
  mes: document.getElementById("calendar-month-label"),
  meses: document.getElementById("calendar-month-options"),
  data: document.getElementById("selected-date-text"),
  status: document.getElementById("availability-status"),
  resumo: document.getElementById("calendario-selecao"),
  contagem: document.getElementById("calendario-contagem"),
  listaResumo: document.getElementById("calendario-resumo-lista"),
  mensagem: document.getElementById("calendario-mensagem"),
  confirmar: document.getElementById("calendario-confirmar"),
  limpar: document.getElementById("calendario-limpar"),
  tentarNovamente: document.getElementById("calendario-tentar-novamente"),
  fechar: document.getElementById("modo-fechar"),
  reabrir: document.getElementById("modo-reabrir"),
};

const estado = {
  meses: [],
  mes: null,
  data: null,
  dataPorMes: new Map(),
  modo: "fechar",
  selecoes: new Map(),
  bloqueados: [],
  ocupados: [],
  carregando: false,
  salvando: false,
  erroConsulta: false,
  requisicao: 0,
  controlador: null,
};

const diasSemana = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const formatoHora = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const sobrepoe = (a, b, c, d) => a < d && b > c;
const estaOcupado = (m) => estado.ocupados.some(({ inicioMinuto, fimMinuto }) => sobrepoe(m, m + 30, inicioMinuto, fimMinuto));
const estaFechado = (m) => estado.bloqueados.some(({ inicioMinuto, fimMinuto }) => sobrepoe(m, m + 30, inicioMinuto, fimMinuto));
const dataFormatada = (iso, opcoes = { weekday: "long", day: "2-digit", month: "long", year: "numeric" }) =>
  new Intl.DateTimeFormat("pt-BR", { ...opcoes, timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const horaFormatada = (minuto) => formatoHora(minuto);
const mesFormatado = (chave) => dataFormatada(`${chave}-01`, { month: "long", year: "numeric" });

function mostrarErro(erro) {
  return formatarFalhaDeRede(erro);
}

async function api(method, path, body, signal) {
  const user = auth.currentUser;
  if (!user) throw new Error("Sua sessão expirou. Entre novamente para continuar.");
  const token = await user.getIdToken();
  const resposta = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal,
  });
  let resultado = null;
  try { resultado = await resposta.json(); } catch { /* resposta não JSON tratada abaixo */ }
  if (!resposta.ok) throw new Error(formatarErroCalendario(resposta.status, resultado || {}));
  if (!resultado || typeof resultado !== "object" || Array.isArray(resultado)) {
    throw new Error("A API respondeu com dados inválidos. Tente consultar novamente.");
  }
  return resultado;
}

function atualizarControles() {
  const resumo = resumirSelecoes(estado.selecoes);
  el.confirmar.disabled = !resumo.quantidadeIntervalos || estado.carregando || estado.salvando || estado.erroConsulta;
  el.confirmar.textContent = estado.modo === "fechar" ? "Fechar horários selecionados" : "Reabrir horários selecionados";
  el.limpar.disabled = !resumo.quantidadeIntervalos || estado.salvando;
  el.fechar.disabled = estado.carregando || estado.salvando || estado.erroConsulta;
  el.reabrir.disabled = estado.carregando || estado.salvando || estado.erroConsulta;
  el.mes.disabled = estado.salvando;
  el.datas.querySelectorAll("button").forEach((botao) => { botao.disabled = estado.salvando; });
  el.tentarNovamente.hidden = !estado.erroConsulta || estado.salvando;
  el.tentarNovamente.disabled = estado.salvando || !estado.data;
  el.conteudo.setAttribute("aria-busy", String(estado.carregando || estado.salvando));
}

function criarBotaoRemover(texto, descricao, aoClicar, classe = "calendario-remover") {
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = classe;
  botao.textContent = texto;
  botao.setAttribute("aria-label", descricao);
  botao.disabled = estado.salvando;
  botao.addEventListener("click", aoClicar);
  return botao;
}

function renderizarResumo() {
  const resumo = resumirSelecoes(estado.selecoes);
  el.listaResumo.replaceChildren();
  if (!resumo.quantidadeDatas) {
    el.resumo.textContent = "Nenhum horário selecionado";
    el.contagem.textContent = estado.modo === "fechar"
      ? "Escolha horários disponíveis em uma ou mais datas."
      : "Escolha intervalos fechados para reabrir.";
    atualizarControles();
    return;
  }

  el.resumo.textContent = `${resumo.quantidadeDatas} ${resumo.quantidadeDatas === 1 ? "data" : "datas"} selecionada${resumo.quantidadeDatas === 1 ? "" : "s"}`;
  el.contagem.textContent = `${resumo.quantidadeIntervalos} intervalos de 30 minutos no total.`;
  for (const item of resumo.datas) {
    const linha = document.createElement("li");
    linha.className = "calendario-resumo-data";
    const cabecalho = document.createElement("div");
    cabecalho.className = "calendario-resumo-data-cabecalho";
    const data = document.createElement("span");
    data.textContent = dataFormatada(item.data, { day: "2-digit", month: "2-digit", year: "numeric" });
    const removerData = criarBotaoRemover(
      "Remover data",
      `Remover todos os horários de ${data.textContent}`,
      () => { estado.selecoes.delete(item.data); renderizarResumo(); renderizarHorarios(); },
    );
    cabecalho.append(data, removerData);
    const intervalos = document.createElement("div");
    intervalos.className = "calendario-resumo-intervalos";
    for (const grupo of item.grupos) {
      const texto = `${horaFormatada(grupo.inicio)} às ${horaFormatada(grupo.fim)}`;
      intervalos.append(criarBotaoRemover(
        texto,
        `Remover intervalo ${texto} de ${data.textContent}`,
        () => {
          removerIntervalos(estado.selecoes, item.data, grupo.inicios);
          renderizarResumo();
          renderizarHorarios();
        },
        "calendario-resumo-intervalo",
      ));
    }
    linha.append(cabecalho, intervalos);
    el.listaResumo.append(linha);
  }
  atualizarControles();
}

function criarPeriodo(titulo, slots) {
  if (!slots.length) return;
  const secao = document.createElement("section");
  secao.className = "agendamento-period";
  const cabecalho = document.createElement("div");
  cabecalho.className = "agendamento-period-heading";
  const nome = document.createElement("strong");
  nome.textContent = titulo;
  const detalhe = document.createElement("span");
  detalhe.textContent = "Intervalos de 30 minutos";
  cabecalho.append(nome, detalhe);
  const grade = document.createElement("div");
  grade.className = "agendamento-time-grid";
  const selecionados = estado.selecoes.get(estado.data) || new Set();
  for (const minuto of slots) {
    const reservado = estaOcupado(minuto);
    const fechado = estaFechado(minuto);
    const selecionado = selecionados.has(minuto);
    const elegivel = estado.modo === "fechar" ? !fechado : fechado;
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "agendamento-time";
    botao.textContent = formatoHora(minuto);
    botao.setAttribute("aria-pressed", String(selecionado));
    botao.setAttribute("aria-label", `${formatoHora(minuto)}, ${reservado ? "reservado" : fechado ? "fechado" : "disponível"}`);
    if (reservado) botao.classList.add("horario-ocupado");
    if (fechado) botao.classList.add("calendario-fechado");
    if (selecionado) botao.classList.add("calendario-selecionado");
    botao.disabled = estado.carregando || estado.salvando || reservado || !elegivel;
    botao.addEventListener("click", () => {
      if (estado.carregando || estado.salvando || reservado || !elegivel) return;
      alternarIntervalo(estado.selecoes, estado.data, minuto);
      renderizarResumo();
      renderizarHorarios();
    });
    grade.append(botao);
  }
  secao.append(cabecalho, grade);
  el.horario.append(secao);
}

function renderizarHorarios() {
  el.horario.replaceChildren();
  el.tentarNovamente.hidden = !estado.erroConsulta;
  if (!estado.data) {
    el.status.textContent = "Selecione uma data";
    el.horario.textContent = "Escolha um dia de atendimento.";
    atualizarControles();
    return;
  }
  if (estado.carregando) {
    el.status.textContent = "Consultando";
    el.horario.textContent = "Carregando horários e reservas…";
    atualizarControles();
    return;
  }
  if (estado.erroConsulta) {
    el.status.textContent = "Consulta falhou";
    el.horario.textContent = "Os horários não foram carregados. A seleção está bloqueada até a consulta ser refeita.";
    atualizarControles();
    return;
  }

  const slots = listarSlotsGerenciaveis(estado.data);
  if (!slots.length) {
    el.status.textContent = "Sem expediente";
    el.horario.textContent = "Não há horários gerenciáveis nesta data.";
    atualizarControles();
    return;
  }
  criarPeriodo("Manhã", slots.filter((m) => m < 720));
  criarPeriodo("Tarde", slots.filter((m) => m >= 720));
  const elegiveis = slots.filter((m) => !estaOcupado(m) && (estado.modo === "fechar" ? !estaFechado(m) : estaFechado(m))).length;
  el.status.textContent = estado.modo === "fechar" ? `${elegiveis} disponíveis` : `${elegiveis} fechados`;
  if (!elegiveis) {
    const vazio = document.createElement("p");
    vazio.className = "agendamento-time-state";
    vazio.textContent = estado.modo === "fechar"
      ? "Não há intervalos disponíveis para fechar nesta data."
      : "Não há intervalos fechados para reabrir nesta data.";
    el.horario.append(vazio);
  }
  atualizarControles();
}

function renderizarMeses() {
  const mes = estado.meses.find((item) => item.chave === estado.mes);
  if (mes) el.mes.textContent = mesFormatado(mes.chave);
  el.meses.replaceChildren();
  for (const item of estado.meses) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "calendario-mes-opcao";
    botao.textContent = mesFormatado(item.chave);
    botao.setAttribute("aria-pressed", String(item.chave === estado.mes));
    botao.addEventListener("click", () => {
      el.meses.hidden = true;
      el.mes.setAttribute("aria-expanded", "false");
      selecionarMes(item.chave);
    });
    el.meses.append(botao);
  }
}

function renderizarDatas() {
  el.datas.replaceChildren();
  const mes = estado.meses.find((item) => item.chave === estado.mes);
  if (!mes) return;
  const datas = [];
  const cursor = new Date(`${mes.inicio}T12:00:00Z`);
  const fim = new Date(`${mes.fim}T12:00:00Z`);
  while (cursor <= fim) {
    const dia = cursor.getUTCDay();
    const data = cursor.toISOString().slice(0, 10);
    if (dia >= 2 && dia <= 6 && listarSlotsGerenciaveis(data).length) datas.push({ data, dia, cursor: new Date(cursor) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (!datas.length) {
    el.datas.textContent = "Não há datas futuras de atendimento neste mês.";
    estado.data = null;
    el.data.textContent = "Selecione uma data";
    renderizarHorarios();
    return;
  }

  const dataAnterior = estado.dataPorMes.get(mes.chave);
  const dataAtiva = obterDataAtiva(datas.map(({ data }) => data), dataAnterior);
  for (const item of datas) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "agendamento-date";
    botao.dataset.dateIso = item.data;
    botao.setAttribute("aria-pressed", String(item.data === dataAtiva));
    botao.setAttribute("aria-label", dataFormatada(item.data));
    if (item.data === dataAtiva) botao.classList.add("agendamento-date--active");
    const diaSemana = document.createElement("span");
    diaSemana.className = "agendamento-date-label";
    diaSemana.textContent = diasSemana[item.dia];
    const numero = document.createElement("span");
    numero.className = "agendamento-date-day";
    numero.textContent = String(item.cursor.getUTCDate()).padStart(2, "0");
    const mesCurto = document.createElement("span");
    mesCurto.className = "agendamento-date-month";
    mesCurto.textContent = new Intl.DateTimeFormat("pt-BR", { month: "short", timeZone: "UTC" }).format(item.cursor);
    botao.append(diaSemana, numero, mesCurto);
    botao.addEventListener("click", () => selecionarData(item.data));
    el.datas.append(botao);
  }
  if (estado.data !== dataAtiva) selecionarData(dataAtiva);
  else {
    el.data.textContent = dataFormatada(dataAtiva);
    renderizarHorarios();
  }
}

function selecionarMes(chave) {
  if (estado.salvando) return;
  if (estado.mes === chave) { renderizarMeses(); return; }
  estado.mes = chave;
  renderizarMeses();
  renderizarDatas();
}

async function carregarDia(data, mensagemFinal = "") {
  if (!data || estado.salvando) return;
  estado.controlador?.abort();
  const numero = ++estado.requisicao;
  const controlador = new AbortController();
  estado.controlador = controlador;
  const timeout = setTimeout(() => controlador.abort(), 15000);
  estado.data = data;
  estado.dataPorMes.set(data.slice(0, 7), data);
  estado.carregando = true;
  estado.erroConsulta = false;
  el.data.textContent = dataFormatada(data);
  el.mensagem.textContent = "Conferindo reservas e horários fechados…";
  renderizarHorarios();
  renderizarResumo();
  try {
    const dia = await api("GET", `/api/admin/calendario?data=${encodeURIComponent(data)}`, null, controlador.signal);
    if (numero !== estado.requisicao) return;
    if (!Array.isArray(dia.ocupados) || !Array.isArray(dia.bloqueados)) {
      throw new Error("A API retornou uma resposta de disponibilidade incompleta.");
    }
    estado.ocupados = dia.ocupados;
    estado.bloqueados = dia.bloqueados;
    const selecionados = estado.selecoes.get(data);
    if (selecionados) {
      const validos = new Set(listarSlotsGerenciaveis(data).filter((minuto) =>
        !estaOcupado(minuto) && (estado.modo === "fechar" ? !estaFechado(minuto) : estaFechado(minuto))));
      removerIntervalos(estado.selecoes, data, [...selecionados].filter((minuto) => !validos.has(minuto)));
    }
    estado.carregando = false;
    estado.erroConsulta = false;
    el.mensagem.textContent = mensagemFinal || "Selecione horários em diferentes datas. Suas escolhas ficam no resumo até confirmar.";
  } catch (erro) {
    if (numero !== estado.requisicao) return;
    estado.carregando = false;
    estado.erroConsulta = true;
    estado.ocupados = [];
    estado.bloqueados = [];
    el.status.textContent = "Consulta falhou";
    el.mensagem.textContent = mostrarErro(erro);
  } finally {
    clearTimeout(timeout);
    if (numero === estado.requisicao) {
      estado.controlador = null;
      renderizarHorarios();
      renderizarResumo();
    }
  }
}

function selecionarData(data) {
  if (estado.salvando) return;
  const dataAnterior = estado.data;
  estado.data = data;
  estado.dataPorMes.set(data.slice(0, 7), data);
  el.datas.querySelectorAll(".agendamento-date").forEach((botao) => {
    const ativo = botao.dataset.dateIso === data;
    botao.classList.toggle("agendamento-date--active", ativo);
    botao.setAttribute("aria-pressed", String(ativo));
  });
  el.data.textContent = dataFormatada(data);
  if (!estado.erroConsulta && !estado.carregando && dataAnterior === data && estado.loadedDate === data) {
    renderizarHorarios();
    return;
  }
  estado.loadedDate = data;
  carregarDia(data);
}

function escolherModo(modo) {
  if (estado.carregando || estado.salvando || estado.erroConsulta || estado.modo === modo) return;
  const resumo = resumirSelecoes(estado.selecoes);
  if (resumo.quantidadeIntervalos && !window.confirm("Trocar entre Fechar e Reabrir limpará a seleção atual para não misturar operações. Continuar?")) return;
  estado.selecoes.clear();
  estado.modo = modo;
  for (const [botao, valor] of [[el.fechar, "fechar"], [el.reabrir, "reabrir"]]) {
    botao.classList.toggle("is-active", valor === modo);
    botao.setAttribute("aria-pressed", String(valor === modo));
  }
  el.mensagem.textContent = modo === "fechar"
    ? "Selecione intervalos disponíveis para fechar."
    : "Selecione intervalos fechados para reabrir.";
  renderizarHorarios();
  renderizarResumo();
}

function textoConfirmacao(payload) {
  const linhas = payload.datas.map(({ data, horas }) => {
    const grupos = agruparIntervalos(horas).map(({ inicio, fim }) => `${formatoHora(inicio)}–${formatoHora(fim)}`).join(", ");
    return `${dataFormatada(data, { day: "2-digit", month: "2-digit", year: "numeric" })}: ${grupos}`;
  });
  const verbo = payload.acao === "fechar" ? "Fechar" : "Reabrir";
  return `${verbo} ${resumirSelecoes(estado.selecoes).quantidadeIntervalos} intervalos em ${payload.datas.length} datas?\n\n${linhas.join("\n")}`;
}

async function confirmarAlteracao() {
  if (estado.salvando || estado.carregando || estado.erroConsulta) return;
  const payload = criarPayloadLote(estado.selecoes, estado.modo);
  if (!payload.datas.length) return;
  if (!window.confirm(textoConfirmacao(payload))) return;

  if (!iniciarOperacaoCalendario(estado)) return;
  el.mensagem.textContent = "Validando e salvando todas as datas numa única operação…";
  renderizarHorarios();
  renderizarResumo();
  try {
    const resultado = await api("POST", "/api/admin/calendario/lote", payload);
    const aplicadas = Array.isArray(resultado.datas) ? resultado.datas : payload.datas.map(({ data }) => data);
    limparDatasAplicadas(estado.selecoes, aplicadas);
    encerrarOperacaoCalendario(estado);
    const sucesso = payload.acao === "fechar" ? "Horários fechados em todas as datas." : "Horários reabertos em todas as datas.";
    renderizarResumo();
    if (estado.data) await carregarDia(estado.data, sucesso);
    else el.mensagem.textContent = sucesso;
  } catch (erro) {
    const mensagem = mostrarErro(erro);
    encerrarOperacaoCalendario(estado);
    renderizarResumo();
    if (estado.data) await carregarDia(estado.data, mensagem);
    else el.mensagem.textContent = mensagem;
  }
}

el.mes.addEventListener("click", () => {
  if (estado.salvando) return;
  el.meses.hidden = !el.meses.hidden;
  el.mes.setAttribute("aria-expanded", String(!el.meses.hidden));
  if (!el.meses.hidden) el.meses.querySelector("[aria-pressed='true']")?.focus();
});
el.mes.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape") {
    el.meses.hidden = true;
    el.mes.setAttribute("aria-expanded", "false");
  }
});
el.meses.addEventListener("keydown", (evento) => {
  if (evento.key === "Escape") {
    el.meses.hidden = true;
    el.mes.setAttribute("aria-expanded", "false");
    el.mes.focus();
  }
});
document.addEventListener("click", (evento) => {
  if (!el.meses.hidden && !evento.target.closest(".calendario-seletor-mes")) {
    el.meses.hidden = true;
    el.mes.setAttribute("aria-expanded", "false");
  }
});
el.fechar.addEventListener("click", () => escolherModo("fechar"));
el.reabrir.addEventListener("click", () => escolherModo("reabrir"));
el.limpar.addEventListener("click", () => {
  if (estado.salvando) return;
  estado.selecoes.clear();
  renderizarResumo();
  renderizarHorarios();
  el.mensagem.textContent = "Seleção removida. Escolha os horários que deseja alterar.";
});
el.tentarNovamente.addEventListener("click", () => carregarDia(estado.data));
el.confirmar.addEventListener("click", confirmarAlteracao);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    estado.controlador?.abort();
    estado.requisicao++;
    el.conteudo.hidden = true;
    el.acesso.hidden = false;
    el.acesso.textContent = "Acesso restrito. Faça login para gerenciar o calendário.";
    return;
  }
  el.acesso.textContent = "Conferindo acesso administrativo…";
  try {
    const usuario = await getDoc(doc(db, "usuarios", user.uid));
    if (auth.currentUser?.uid !== user.uid) return;
    if (!usuario.exists() || usuario.data()?.role !== "admin" || usuario.data()?.ativo !== true) {
      el.conteudo.hidden = true;
      el.acesso.hidden = false;
      el.acesso.textContent = "Apenas a administradora pode gerenciar o calendário.";
      return;
    }
    el.acesso.hidden = true;
    el.conteudo.hidden = false;
    estado.meses = obterMesesGerenciaveis();
    estado.mes = estado.meses[0]?.chave || null;
    renderizarMeses();
    renderizarDatas();
  } catch {
    el.conteudo.hidden = true;
    el.acesso.hidden = false;
    el.acesso.textContent = "Não foi possível confirmar sua permissão. Atualize a página e tente novamente.";
  }
});
