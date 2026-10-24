import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { obterJanelaAgendamento, listarSlotsGerenciaveis } from "./infra/backend/src/agendamentoRegras.mjs";

const el = {
  acesso: document.getElementById("calendario-acesso"),
  conteudo: document.getElementById("calendario-main"),
  datas: document.querySelector(".agendamento-calendar"),
  horario: document.querySelector(".agendamento-times"),
  mes: document.getElementById("calendar-month-label"),
  data: document.getElementById("selected-date-text"),
  status: document.getElementById("availability-status"),
  resumo: document.getElementById("calendario-selecao"),
  mensagem: document.getElementById("calendario-mensagem"),
  confirmar: document.getElementById("calendario-confirmar"),
  fechar: document.getElementById("modo-fechar"),
  reabrir: document.getElementById("modo-reabrir"),
};
const estado = { data: null, modo: "fechar", selecionados: new Set(), bloqueados: [], ocupados: [], carregando: false, requisicao: 0 };
const diasSemana = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const meses = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const formatoHora = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const sobrepoe = (a, b, c, d) => a < d && b > c;
const estaOcupado = (m) => estado.ocupados.some(({ inicioMinuto, fimMinuto }) => sobrepoe(m, m + 30, inicioMinuto, fimMinuto));
const estaFechado = (m) => estado.bloqueados.some(({ inicioMinuto, fimMinuto }) => sobrepoe(m, m + 30, inicioMinuto, fimMinuto));
const dataFormatada = (iso) => new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
const horasValidas = () => listarSlotsGerenciaveis(estado.data);
function atualizarResumo() {
  const quantidade = estado.selecionados.size;
  el.resumo.textContent = quantidade ? `${quantidade} intervalo${quantidade === 1 ? "" : "s"} de 30 minutos selecionado${quantidade === 1 ? "" : "s"}` : "Nenhum horário selecionado";
  el.confirmar.disabled = quantidade === 0 || estado.carregando;
  el.confirmar.textContent = estado.modo === "fechar" ? "Fechar Agenda" : "Reabrir horários";
}
function escolherModo(modo) {
  estado.modo = modo;
  estado.selecionados.clear();
  for (const [botao, valor] of [[el.fechar, "fechar"], [el.reabrir, "reabrir"]]) {
    botao.classList.toggle("is-active", valor === modo);
    botao.setAttribute("aria-pressed", String(valor === modo));
  }
  el.mensagem.textContent = modo === "fechar" ? "Selecione horários disponíveis para fechar." : "Selecione horários fechados para reabrir.";
  renderizarHorarios();
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
  for (const minuto of slots) {
    const reservado = estaOcupado(minuto);
    const fechado = estaFechado(minuto);
    const selecionado = estado.selecionados.has(minuto);
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "agendamento-time";
    botao.textContent = formatoHora(minuto);
    botao.setAttribute("aria-pressed", String(selecionado));
    botao.setAttribute("aria-label", `${formatoHora(minuto)}, ${reservado ? "reservado" : fechado ? "fechado" : "disponível"}`);
    if (reservado) botao.classList.add("horario-ocupado");
    if (fechado) botao.classList.add("calendario-fechado");
    if (selecionado) botao.classList.add("calendario-selecionado");
    botao.disabled = estado.carregando || reservado || (estado.modo === "fechar" ? fechado : !fechado);
    botao.addEventListener("click", () => {
      if (estado.selecionados.has(minuto)) estado.selecionados.delete(minuto);
      else estado.selecionados.add(minuto);
      renderizarHorarios();
    });
    grade.append(botao);
  }
  secao.append(cabecalho, grade);
  el.horario.append(secao);
}
function renderizarHorarios() {
  el.horario.replaceChildren();
  const slots = horasValidas();
  if (!slots.length) {
    const vazio = document.createElement("p");
    vazio.className = "agendamento-time-state";
    vazio.textContent = "Não há horários gerenciáveis nesta data.";
    el.horario.append(vazio);
  } else {
    criarPeriodo("Manhã", slots.filter((m) => m < 720));
    criarPeriodo("Tarde e noite", slots.filter((m) => m >= 720));
  }
  const disponiveis = slots.filter((m) => !estaFechado(m) && !estaOcupado(m)).length;
  el.status.textContent = `${disponiveis} disponíveis`;
  atualizarResumo();
}
async function api(method, data, body) {
  const user = auth.currentUser;
  if (!user) throw new Error("Entre novamente na sua conta.");
  const token = await user.getIdToken();
  const resposta = await fetch(`/api/admin/calendario${method === "GET" ? `?data=${encodeURIComponent(data)}` : ""}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const resultado = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(resultado.erro || "Falha ao consultar a disponibilidade.");
  return resultado;
}
async function carregarDia(data) {
  const numero = ++estado.requisicao;
  estado.data = data;
  estado.selecionados.clear();
  estado.bloqueados = [];
  estado.ocupados = [];
  estado.carregando = true;
  el.data.textContent = dataFormatada(data);
  el.mensagem.textContent = "Conferindo reservas e horários fechados...";
  el.status.textContent = "Buscando";
  el.horario.textContent = "Carregando horários...";
  atualizarResumo();
  try {
    const dia = await api("GET", data);
    if (numero !== estado.requisicao) return;
    if (!Array.isArray(dia.ocupados) || !Array.isArray(dia.bloqueados)) throw new Error("Dados de disponibilidade inválidos");
    estado.ocupados = dia.ocupados;
    estado.bloqueados = dia.bloqueados;
    el.mensagem.textContent = "Toque em vários horários e confirme a alteração.";
  } catch (erro) {
    if (numero !== estado.requisicao) return;
    el.mensagem.textContent = erro.message;
    el.status.textContent = "Indisponível";
    estado.carregando = true;
    el.horario.textContent = "Falha ao consultar horários. Selecione novamente o dia para tentar.";
    atualizarResumo();
    return;
  }
  estado.carregando = false;
  renderizarHorarios();
}
function criarCalendario() {
  const janela = obterJanelaAgendamento();
  if (janela.inicio > janela.fim) {
    el.datas.textContent = "Não há datas disponíveis nesta janela.";
    return;
  }
  const inicio = new Date(`${janela.inicio}T12:00:00Z`);
  const fim = new Date(`${janela.fim}T12:00:00Z`);
  let primeira = null;
  for (let cursor = new Date(inicio); cursor <= fim; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const dia = cursor.getUTCDay();
    if (dia < 2 || dia > 6) continue;
    const data = cursor.toISOString().slice(0, 10);
    if (!listarSlotsGerenciaveis(data).length) continue; // Dezembro bloqueado permanece indisponível.
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "agendamento-date";
    botao.dataset.dateIso = data;
    botao.setAttribute("aria-pressed", "false");
    botao.setAttribute("aria-label", dataFormatada(data));
    const diaSemana = document.createElement("span");
    diaSemana.className = "agendamento-date-label";
    diaSemana.textContent = diasSemana[dia];
    const numero = document.createElement("span");
    numero.className = "agendamento-date-day";
    numero.textContent = String(cursor.getUTCDate()).padStart(2, "0");
    const mes = document.createElement("span");
    mes.className = "agendamento-date-month";
    mes.textContent = meses[cursor.getUTCMonth()];
    botao.append(diaSemana, numero, mes);
    botao.addEventListener("click", () => {
      el.datas.querySelectorAll(".agendamento-date").forEach((b) => {
        const ativo = b === botao;
        b.classList.toggle("agendamento-date--active", ativo);
        b.setAttribute("aria-pressed", String(ativo));
      });
      el.mes.textContent = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${data}T12:00:00Z`));
      carregarDia(data);
    });
    el.datas.append(botao);
    if (!primeira) primeira = botao;
  }
  primeira?.click();
}
el.fechar.addEventListener("click", () => escolherModo("fechar"));
el.reabrir.addEventListener("click", () => escolherModo("reabrir"));
el.confirmar.addEventListener("click", async () => {
  if (!estado.data || !estado.selecionados.size || estado.carregando) return;
  const data = estado.data;
  const acao = estado.modo;
  const horas = [...estado.selecionados].sort((a, b) => a - b);
  estado.carregando = true;
  renderizarHorarios();
  el.mensagem.textContent = "Salvando alteração...";
  try {
    await api("POST", data, { data, acao, horas });
    if (estado.data !== data) return;
    await carregarDia(data);
    el.mensagem.textContent = acao === "fechar" ? "Horários fechados com sucesso." : "Horários reabertos com sucesso.";
  } catch (erro) {
    estado.carregando = false;
    el.mensagem.textContent = erro.message;
    // Atualiza o dia para recuperar conflitos surgidos durante a seleção.
    await carregarDia(data);
    el.mensagem.textContent = erro.message;
  }
});
onAuthStateChanged(auth, async (user) => {
  if (!user) { el.acesso.textContent = "Acesso restrito. Faça login para gerenciar o calendário."; return; }
  try {
    const usuario = await getDoc(doc(db, "usuarios", user.uid));
    if (auth.currentUser?.uid !== user.uid) return;
    if (!usuario.exists() || usuario.data()?.role !== "admin" || usuario.data()?.ativo !== true) {
      el.acesso.textContent = "Apenas a administradora pode gerenciar o calendário.";
      return;
    }
    el.acesso.hidden = true;
    el.conteudo.hidden = false;
    criarCalendario();
  } catch { el.acesso.textContent = "Não foi possível confirmar a permissão administrativa."; }
});
