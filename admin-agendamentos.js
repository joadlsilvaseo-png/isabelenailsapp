import { auth, db } from "./firebase-config.js";
import { webhookUrl } from "./config.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

/* ============================================================
   ESTADO
   ============================================================ */

let todosAgendamentos = [];
let agendamentosFiltrados = [];
let agendamentoSelecionadoId = null;

let filtroResumoAtivo = "hoje";
let filtroStatusAtivo = "todos";

let buscaAtual = "";
let dataFiltroAtual = "";

let carregamentoEmAndamento = false;

/* ============================================================
   ELEMENTOS
   ============================================================ */

const elements = {};

function carregarElementos() {
  elements.body = document.body;

  elements.accessLoading = document.getElementById("admin-access-loading");

  elements.accessError = document.getElementById("admin-access-error");

  elements.accessErrorTitle = document.getElementById(
    "admin-access-error-title",
  );

  elements.accessErrorMessage = document.getElementById(
    "admin-access-error-message",
  );

  elements.content = document.getElementById("admin-agendamentos-content");

  elements.refreshButton = document.getElementById("admin-refresh-button");

  elements.currentDate = document.getElementById("admin-current-date");
  elements.summaryGrid = document.querySelector(".admin-summary-grid");

  elements.totalHoje = document.getElementById("admin-total-hoje");

  elements.totalPendentes = document.getElementById("admin-total-pendentes");

  elements.totalConfirmados = document.getElementById(
    "admin-total-confirmados",
  );

  elements.totalConcluidos = document.getElementById("admin-total-concluidos");

  elements.searchForm = document.getElementById(
    "admin-agendamentos-search-form",
  );

  elements.searchInput = document.getElementById(
    "admin-agendamentos-search-input",
  );

  elements.dateFilter = document.getElementById(
    "admin-agendamentos-date-filter",
  );

  elements.statusFilters = document.getElementById("admin-status-filters");

  elements.resultsCount = document.getElementById("admin-results-count");

  elements.listLoading = document.getElementById("admin-list-loading");

  elements.list = document.getElementById("admin-agendamentos-list");

  elements.empty = document.getElementById("admin-list-empty");

  elements.emptyTitle = document.getElementById("admin-empty-title");

  elements.emptyMessage = document.getElementById("admin-empty-message");

  elements.clearFiltersButton = document.getElementById(
    "admin-clear-filters-button",
  );

  elements.listError = document.getElementById("admin-list-error");

  elements.retryButton = document.getElementById("admin-list-retry-button");

  elements.modal = document.getElementById("admin-agendamento-modal");

  elements.modalContent = document.getElementById("admin-modal-content");

  elements.modalActions = document.getElementById("admin-modal-actions");
}

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

function escaparHTML(valor) {
  return String(valor ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizarTexto(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function obterPrimeiroValor(dados, campos, fallback = "") {
  for (const campo of campos) {
    const valor = dados?.[campo];

    if (valor !== undefined && valor !== null && String(valor).trim() !== "") {
      return valor;
    }
  }

  return fallback;
}

function obterNomeCliente(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      ["nomeCliente", "clienteNome", "nome", "cliente"],
      "Cliente",
    ),
  ).trim();
}

function obterEmailCliente(dados) {
  return String(
    obterPrimeiroValor(dados, ["emailCliente", "clienteEmail", "email"], ""),
  ).trim();
}

function obterTelefoneCliente(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      [
        "telefoneCliente",
        "celularCliente",
        "clienteTelefone",
        "telefone",
        "celular",
        "whatsapp",
      ],
      "",
    ),
  ).trim();
}
function obterClienteId(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      ["clienteId", "idCliente", "usuarioId", "uidCliente", "userId"],
      "",
    ),
  ).trim();
}

function obterFotoCliente(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      ["fotoCliente", "clienteFoto", "foto", "photoURL", "fotoPerfil"],
      "",
    ),
  ).trim();
}
function obterServico(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      ["servico", "nomeServico", "servicoNome"],
      "Serviço não informado",
    ),
  ).trim();
}

function obterData(dados) {
  return String(
    obterPrimeiroValor(dados, ["data", "dataAgendamento"], ""),
  ).trim();
}

function obterHorario(dados) {
  return String(obterPrimeiroValor(dados, ["horario", "hora"], "")).trim();
}

function obterObservacao(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      ["observacao", "observacoes", "mensagem", "detalhes"],
      "Nenhuma observação informada.",
    ),
  ).trim();
}

function normalizarStatus(status) {
  return String(status || "agendado")
    .trim()
    .toLowerCase()
    .replace("concluído", "concluido");
}

function obterGrupoStatus(status) {
  const statusNormalizado = normalizarStatus(status);

  /*
   * Somente agendamentos novos ficam
   * aguardando uma ação da profissional.
   */
  if (statusNormalizado === "agendado") {
    return "agendados";
  }

  /*
   * Ao reagendar, a nova data já foi definida
   * pela profissional. Portanto, o atendimento
   * passa a ser considerado confirmado.
   */
  if (
    statusNormalizado === "confirmado" ||
    statusNormalizado === "reagendado"
  ) {
    return "confirmados";
  }

  if (statusNormalizado === "concluido" || statusNormalizado === "realizado") {
    return "concluidos";
  }

  if (statusNormalizado.startsWith("cancelado")) {
    return "cancelados";
  }

  return "agendados";
}

function obterRotuloStatus(status) {
  const statusNormalizado = normalizarStatus(status);

  const rotulos = {
    agendado: "Agendado",
    confirmado: "Confirmado",
    reagendado: "Reagendado",
    concluido: "Concluído",
    realizado: "Realizado",
    cancelado_cliente: "Cancelado pela cliente",
    cancelado_profissional: "Cancelado pela profissional",
    cancelado_admin: "Cancelado pela profissional",
  };

  return rotulos[statusNormalizado] || statusNormalizado || "Agendado";
}

function obterClasseStatus(status) {
  const statusNormalizado = normalizarStatus(status);

  if (statusNormalizado.startsWith("cancelado")) {
    return "cancelado";
  }

  if (statusNormalizado === "concluido" || statusNormalizado === "realizado") {
    return "concluido";
  }

  if (statusNormalizado === "confirmado") {
    return "confirmado";
  }

  if (statusNormalizado === "reagendado") {
    return "reagendado";
  }

  return "agendado";
}

function obterIniciais(nome) {
  const partes = String(nome || "Cliente")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (partes.length === 0) {
    return "CL";
  }

  if (partes.length === 1) {
    return partes[0].slice(0, 2).toUpperCase();
  }

  return `${partes[0][0]}${partes.at(-1)[0]}`.toUpperCase();
}
function converterValorMonetario(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return 0;
  }

  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : 0;
  }

  let texto = String(valor).trim().replace(/R\$/gi, "").replace(/\s/g, "");

  if (texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  }

  texto = texto.replace(/[^0-9.-]/g, "");

  const numero = Number(texto);

  return Number.isFinite(numero) ? numero : 0;
}

function formatarValorMonetario(valor) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(valor);
}

function obterValorSugeridoAgendamento(agendamento) {
  return converterValorMonetario(
    obterPrimeiroValor(
      agendamento,
      ["valorFinal", "precoSnapshot", "valor", "preco"],
      0,
    ),
  );
}
/* ============================================================
   DATAS
   ============================================================ */

function converterParaData(valor) {
  if (!valor) {
    return null;
  }

  if (typeof valor?.toDate === "function") {
    const dataTimestamp = valor.toDate();

    return Number.isNaN(dataTimestamp.getTime()) ? null : dataTimestamp;
  }

  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : valor;
  }

  const texto = String(valor).trim();

  if (!texto) {
    return null;
  }

  const formatoISO = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (formatoISO) {
    return new Date(
      Number(formatoISO[1]),
      Number(formatoISO[2]) - 1,
      Number(formatoISO[3]),
    );
  }

  const formatoBrasileiro = texto.match(
    /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/,
  );

  if (formatoBrasileiro) {
    const dia = Number(formatoBrasileiro[1]);
    const mes = Number(formatoBrasileiro[2]) - 1;

    let ano = formatoBrasileiro[3]
      ? Number(formatoBrasileiro[3])
      : new Date().getFullYear();

    if (ano < 100) {
      ano += 2000;
    }

    return new Date(ano, mes, dia);
  }

  const tentativa = new Date(texto);

  return Number.isNaN(tentativa.getTime()) ? null : tentativa;
}

function obterChaveData(valor) {
  const data = converterParaData(valor);

  if (!data) {
    return "";
  }

  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");

  const dia = String(data.getDate()).padStart(2, "0");

  return `${ano}-${mes}-${dia}`;
}

function formatarDataVisual(valor) {
  const data = converterParaData(valor);

  if (!data) {
    return valor || "Data não informada";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(data);
}

function formatarDataParaSalvar(data) {
  const dia = String(data.getDate()).padStart(2, "0");

  const mes = String(data.getMonth() + 1).padStart(2, "0");

  const ano = data.getFullYear();

  return `${dia}/${mes}/${ano}`;
}

function obterDataHoraAgendamento(dados) {
  const data = converterParaData(obterData(dados));

  if (!data) {
    return null;
  }

  const horario = obterHorario(dados);

  const horarioMatch = horario.match(/^(\d{1,2}):(\d{2})$/);

  if (horarioMatch) {
    data.setHours(Number(horarioMatch[1]), Number(horarioMatch[2]), 0, 0);
  } else {
    data.setHours(23, 59, 0, 0);
  }

  return data;
}

function obterChaveHoje() {
  return obterChaveData(new Date());
}

/* ============================================================
   ACESSO ADMINISTRATIVO
   ============================================================ */

async function verificarAcessoAdmin(user) {
  const usuarioRef = doc(db, "usuarios", user.uid);

  const usuarioSnap = await getDoc(usuarioRef);

  if (usuarioSnap.exists()) {
    const usuarioData = usuarioSnap.data();

    return (
      String(usuarioData.role || "").toLowerCase() === "admin" &&
      usuarioData.ativo === true
    );
  }

  /*
   * Compatibilidade temporária com o perfil
   * administrativo antigo em clientes/{uid}.
   */
  const clienteRef = doc(db, "clientes", user.uid);

  const clienteSnap = await getDoc(clienteRef);

  return (
    clienteSnap.exists() &&
    String(clienteSnap.data().role || "").toLowerCase() === "admin"
  );
}

function mostrarAcessoNegado(titulo, mensagem) {
  elements.body.dataset.accessState = "denied";

  elements.accessLoading.hidden = true;
  elements.content.hidden = true;

  elements.accessError.hidden = false;

  elements.accessErrorTitle.textContent = titulo;

  elements.accessErrorMessage.textContent = mensagem;
}

function liberarConteudoAdmin() {
  elements.body.dataset.accessState = "allowed";

  elements.accessLoading.hidden = true;
  elements.accessError.hidden = true;
  elements.content.hidden = false;
}

/* ============================================================
   CARREGAMENTO DOS AGENDAMENTOS
   ============================================================ */

function mostrarCarregamentoLista() {
  elements.listLoading.hidden = false;
  elements.list.hidden = true;
  elements.empty.hidden = true;
  elements.listError.hidden = true;
}

function mostrarErroLista() {
  elements.listLoading.hidden = true;
  elements.list.hidden = true;
  elements.empty.hidden = true;
  elements.listError.hidden = false;
}

async function carregarAgendamentos() {
  if (carregamentoEmAndamento) {
    return;
  }

  carregamentoEmAndamento = true;

  mostrarCarregamentoLista();

  if (elements.refreshButton) {
    elements.refreshButton.disabled = true;
  }

  try {
    const [agendamentosSnapshot, clientesSnapshot] = await Promise.all([
      getDocs(collection(db, "agendamentos")),

      getDocs(collection(db, "clientes")),
    ]);

    const clientesPorId = new Map(
      clientesSnapshot.docs.map((documentoCliente) => [
        documentoCliente.id,
        documentoCliente.data(),
      ]),
    );

    todosAgendamentos = agendamentosSnapshot.docs.map((documento) => {
      const dadosAgendamento = documento.data();

      const clienteId = obterClienteId(dadosAgendamento);

      const dadosCliente = clientesPorId.get(clienteId) || {};

      return {
        id: documento.id,
        ...dadosAgendamento,

        clienteId: clienteId || dadosAgendamento.clienteId || "",

        nomeCliente: obterPrimeiroValor(
          dadosCliente,
          ["nome", "nomeCliente"],
          obterNomeCliente(dadosAgendamento),
        ),

        emailCliente: obterPrimeiroValor(
          dadosCliente,
          ["email", "emailCliente"],
          obterEmailCliente(dadosAgendamento),
        ),

        telefoneCliente: obterPrimeiroValor(
          dadosCliente,
          ["telefone", "celular", "whatsapp"],
          obterTelefoneCliente(dadosAgendamento),
        ),

        fotoCliente: obterPrimeiroValor(
          dadosCliente,
          ["foto", "photoURL", "fotoPerfil"],
          obterFotoCliente(dadosAgendamento),
        ),
      };
    });

    ordenarAgendamentos();
    atualizarResumo();
    atualizarContadoresFiltros();
    aplicarFiltros();
  } catch (error) {
    console.error("Erro ao carregar agendamentos:", error);

    mostrarErroLista();
  } finally {
    carregamentoEmAndamento = false;

    if (elements.refreshButton) {
      elements.refreshButton.disabled = false;
    }
  }
}

function ordenarAgendamentos() {
  todosAgendamentos.sort((a, b) => {
    const grupoA = obterGrupoStatus(a.status);

    const grupoB = obterGrupoStatus(b.status);

    const finalizadoA = grupoA === "concluidos" || grupoA === "cancelados";

    const finalizadoB = grupoB === "concluidos" || grupoB === "cancelados";

    if (finalizadoA !== finalizadoB) {
      return finalizadoA ? 1 : -1;
    }

    const dataA = obterDataHoraAgendamento(a);

    const dataB = obterDataHoraAgendamento(b);

    if (!dataA && !dataB) {
      return 0;
    }

    if (!dataA) {
      return 1;
    }

    if (!dataB) {
      return -1;
    }

    if (finalizadoA && finalizadoB) {
      return dataB.getTime() - dataA.getTime();
    }

    return dataA.getTime() - dataB.getTime();
  });
}

/* ============================================================
   RESUMO E FILTROS
   ============================================================ */

function atualizarResumo() {
  const hoje = obterChaveHoje();

  const totalHoje = todosAgendamentos.filter(
    (agendamento) =>
      obterChaveData(obterData(agendamento)) === hoje &&
      obterGrupoStatus(agendamento.status) !== "cancelados",
  ).length;

  const totalPendentes = todosAgendamentos.filter(
    (agendamento) => obterGrupoStatus(agendamento.status) === "agendados",
  ).length;

  const totalConfirmados = todosAgendamentos.filter(
    (agendamento) => obterGrupoStatus(agendamento.status) === "confirmados",
  ).length;

  const totalConcluidos = todosAgendamentos.filter(
    (agendamento) => obterGrupoStatus(agendamento.status) === "concluidos",
  ).length;

  elements.totalHoje.textContent = totalHoje;

  elements.totalPendentes.textContent = totalPendentes;

  elements.totalConfirmados.textContent = totalConfirmados;

  elements.totalConcluidos.textContent = totalConcluidos;
}

function atualizarContadoresFiltros() {
  const contadores = {
    todos: todosAgendamentos.length,
    agendados: 0,
    confirmados: 0,
    concluidos: 0,
    cancelados: 0,
  };

  todosAgendamentos.forEach((agendamento) => {
    const grupo = obterGrupoStatus(agendamento.status);

    if (grupo in contadores) {
      contadores[grupo] += 1;
    }
  });

  document.querySelectorAll("[data-filter-count]").forEach((elemento) => {
    const filtro = elemento.dataset.filterCount;

    elemento.textContent = contadores[filtro] || 0;
  });
}
function atualizarEstadoCardsResumo() {
  document.querySelectorAll("[data-summary-filter]").forEach((card) => {
    const ativo = card.dataset.summaryFilter === filtroResumoAtivo;

    card.classList.toggle("is-active", ativo);

    card.setAttribute("aria-pressed", String(ativo));
  });
}

function atualizarEstadoFiltrosStatus() {
  document.querySelectorAll("[data-status-filter]").forEach((button) => {
    const ativo = button.dataset.statusFilter === filtroStatusAtivo;

    button.classList.toggle("is-active", ativo);

    button.setAttribute("aria-pressed", String(ativo));
  });
}

function selecionarFiltroResumo(filtro) {
  filtroResumoAtivo = filtro;

  /*
   * Ao usar um card superior, removemos
   * qualquer data personalizada.
   */
  dataFiltroAtual = "";

  if (elements.dateFilter) {
    elements.dateFilter.value = "";
  }

  const statusPorResumo = {
    hoje: "todos",
    agendados: "agendados",
    confirmados: "confirmados",
    concluidos: "concluidos",
  };

  filtroStatusAtivo = statusPorResumo[filtro] || "todos";

  atualizarEstadoCardsResumo();
  atualizarEstadoFiltrosStatus();
  aplicarFiltros();
}
function aplicarFiltros() {
  const buscaNormalizada = normalizarTexto(buscaAtual);

  const chaveHoje = obterChaveHoje();

  agendamentosFiltrados = todosAgendamentos.filter((agendamento) => {
    const grupo = obterGrupoStatus(agendamento.status);

    const chaveDataAgendamento = obterChaveData(obterData(agendamento));

    /*
     * Filtro dos cards superiores.
     */
    let combinaResumo = true;

    if (filtroResumoAtivo === "hoje") {
      combinaResumo =
        chaveDataAgendamento === chaveHoje && grupo !== "cancelados";
    }

    if (filtroResumoAtivo === "agendados") {
      combinaResumo = grupo === "agendados";
    }

    if (filtroResumoAtivo === "confirmados") {
      combinaResumo = grupo === "confirmados";
    }

    if (filtroResumoAtivo === "concluidos") {
      combinaResumo = grupo === "concluidos";
    }

    /*
     * Filtro inferior de status.
     */
    const combinaStatus =
      filtroStatusAtivo === "todos" || grupo === filtroStatusAtivo;

    /*
     * Filtro manual de data.
     */
    const combinaData =
      !dataFiltroAtual || chaveDataAgendamento === dataFiltroAtual;

    const textoPesquisavel = normalizarTexto(`
            ${obterNomeCliente(agendamento)}
            ${obterEmailCliente(agendamento)}
            ${obterTelefoneCliente(agendamento)}
            ${obterServico(agendamento)}
            ${obterData(agendamento)}
            ${obterHorario(agendamento)}
          `);

    const combinaBusca =
      !buscaNormalizada || textoPesquisavel.includes(buscaNormalizada);

    return combinaResumo && combinaStatus && combinaData && combinaBusca;
  });

  renderizarLista();
}

/* ============================================================
   CARD DE AGENDAMENTO
   ============================================================ */

function obterIconeCalendario() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="4"
        y="5"
        width="16"
        height="15"
        rx="3"
        stroke="currentColor"
        stroke-width="1.8"
      ></rect>

      <path
        d="M8 3V7M16 3V7M4 10H20"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      ></path>
    </svg>
  `;
}

function obterIconeRelogio() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="1.8"
      ></circle>

      <path
        d="M12 7V12L15 14"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
    </svg>
  `;
}

function obterIconeServico() {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3L13.2 6.2L16.5 7.5L13.2 8.8L12 12L10.8 8.8L7.5 7.5L10.8 6.2L12 3Z"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>

      <path
        d="M18 13L18.8 15.2L21 16L18.8 16.8L18 19L17.2 16.8L15 16L17.2 15.2L18 13Z"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
    </svg>
  `;
}

function criarCardAgendamento(agendamento) {
  const nomeCliente = obterNomeCliente(agendamento);

  const emailCliente = obterEmailCliente(agendamento);

  const telefoneCliente = obterTelefoneCliente(agendamento);

  const fotoCliente = obterFotoCliente(agendamento);

  const servico = obterServico(agendamento);

  const dataVisual = formatarDataVisual(obterData(agendamento));

  const horario = obterHorario(agendamento) || "Horário não informado";

  const status = normalizarStatus(agendamento.status);

  const classeStatus = obterClasseStatus(status);

  const rotuloStatus = obterRotuloStatus(status);

  const contato = telefoneCliente || emailCliente || "Contato não informado";

  return `
    <article
      class="admin-agendamento-card"
      data-agendamento-id="${escaparHTML(agendamento.id)}"
    >
      <header class="admin-agendamento-card-header">

        <div class="admin-agendamento-cliente">

          <span
  class="admin-agendamento-avatar"
  aria-hidden="true"
>
  ${
    fotoCliente
      ? `
        <img
          src="${escaparHTML(fotoCliente)}"
          alt=""
          loading="lazy"
        >
      `
      : escaparHTML(obterIniciais(nomeCliente))
  }
</span>

          <div class="admin-agendamento-cliente-info">
            <strong>
              ${escaparHTML(nomeCliente)}
            </strong>

            <span>
              ${escaparHTML(contato)}
            </span>
          </div>

        </div>

        <span
          class="admin-status-badge admin-status-badge--${escaparHTML(classeStatus)}"
        >
          ${escaparHTML(rotuloStatus)}
        </span>

      </header>

      <div class="admin-agendamento-service">

        <span
          class="admin-agendamento-service-icon"
          aria-hidden="true"
        >
          ${obterIconeServico()}
        </span>

        <div>
          <strong>
            ${escaparHTML(servico)}
          </strong>

          <span>
            Serviço agendado
          </span>
        </div>

      </div>

      <div class="admin-agendamento-meta">

        <div class="admin-agendamento-meta-item">
          ${obterIconeCalendario()}

          <div>
            <span>Data</span>

            <strong>
              ${escaparHTML(dataVisual)}
            </strong>
          </div>
        </div>

        <div class="admin-agendamento-meta-item">
          ${obterIconeRelogio()}

          <div>
            <span>Horário</span>

            <strong>
              ${escaparHTML(horario)}
            </strong>
          </div>
        </div>

      </div>

      <div class="admin-agendamento-actions">

        <button
          type="button"
          class="admin-card-button admin-card-button--primary"
          data-action="detalhes"
          data-id="${escaparHTML(agendamento.id)}"
        >
          Ver detalhes
        </button>

        <button
          type="button"
          class="admin-card-button admin-card-button--icon"
          data-action="whatsapp"
          data-id="${escaparHTML(agendamento.id)}"
          aria-label="Abrir WhatsApp da cliente"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M20 11.5A8.5 8.5 0 0 1 7.4 18.9L4 20L5.1 16.7A8.5 8.5 0 1 1 20 11.5Z"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            ></path>

            <path
              d="M9 8.5C9.5 11 11 12.5 13.5 13"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            ></path>
          </svg>
        </button>

      </div>

    </article>
  `;
}

function renderizarLista() {
  elements.listLoading.hidden = true;
  elements.listError.hidden = true;

  const quantidade = agendamentosFiltrados.length;

  elements.resultsCount.textContent =
    quantidade === 1 ? "1 registro" : `${quantidade} registros`;

  if (quantidade === 0) {
    elements.list.hidden = true;
    elements.empty.hidden = false;

    const visualizacaoHoje =
      filtroResumoAtivo === "hoje" &&
      !buscaAtual &&
      !dataFiltroAtual &&
      filtroStatusAtivo === "todos";

    if (visualizacaoHoje) {
      elements.emptyTitle.textContent = "Nenhum atendimento hoje";

      elements.emptyMessage.textContent =
        "Não existem atendimentos agendados para a data de hoje.";

      /*
       * Não exibimos o botão Limpar filtros,
       * pois hoje já é o estado inicial da tela.
       */
      elements.clearFiltersButton.hidden = true;
    } else {
      elements.emptyTitle.textContent = "Nenhum agendamento encontrado";

      elements.emptyMessage.textContent =
        "Não existem registros para os filtros selecionados.";

      elements.clearFiltersButton.hidden = false;
    }

    return;
  }
  elements.clearFiltersButton.hidden = false;
  elements.empty.hidden = true;
  elements.list.hidden = false;

  elements.list.innerHTML = agendamentosFiltrados
    .map(criarCardAgendamento)
    .join("");
}

/* ============================================================
   MODAL
   ============================================================ */

function encontrarAgendamento(id) {
  return todosAgendamentos.find((agendamento) => agendamento.id === id);
}

function abrirModal(id) {
  const agendamento = encontrarAgendamento(id);

  if (!agendamento) {
    return;
  }

  agendamentoSelecionadoId = id;

  const nomeCliente = obterNomeCliente(agendamento);

  const telefoneCliente = obterTelefoneCliente(agendamento);

  const emailCliente = obterEmailCliente(agendamento);

  const fotoCliente = obterFotoCliente(agendamento);

  const servico = obterServico(agendamento);

  const dataVisual = formatarDataVisual(obterData(agendamento));

  const horario = obterHorario(agendamento) || "Não informado";

  const status = normalizarStatus(agendamento.status);

  const observacao = obterObservacao(agendamento);

  elements.modalContent.innerHTML = `
    <div class="admin-modal-client">

      <span
  class="admin-modal-client-avatar"
  aria-hidden="true"
>
  ${
    fotoCliente
      ? `
        <img
          src="${escaparHTML(fotoCliente)}"
          alt=""
          loading="lazy"
        >
      `
      : escaparHTML(obterIniciais(nomeCliente))
  }
</span>

      <div>
        <strong>
          ${escaparHTML(nomeCliente)}
        </strong>

        <span>
          ${escaparHTML(
            telefoneCliente || emailCliente || "Contato não informado",
          )}
        </span>
      </div>

    </div>

    <div class="admin-modal-details-grid">

      <div class="admin-modal-detail">
        <span>Serviço</span>

        <strong>
          ${escaparHTML(servico)}
        </strong>
      </div>

      <div class="admin-modal-detail">
        <span>Status</span>

        <strong>
          ${escaparHTML(obterRotuloStatus(status))}
        </strong>
      </div>

      <div class="admin-modal-detail">
        <span>Data</span>

        <strong>
          ${escaparHTML(dataVisual)}
        </strong>
      </div>

      <div class="admin-modal-detail">
        <span>Horário</span>

        <strong>
          ${escaparHTML(horario)}
        </strong>
      </div>

      <div class="admin-modal-detail">
        <span>Telefone</span>

        <strong>
          ${escaparHTML(telefoneCliente || "Não informado")}
        </strong>
      </div>

      <div class="admin-modal-detail">
        <span>E-mail</span>

        <strong>
          ${escaparHTML(emailCliente || "Não informado")}
        </strong>
      </div>

    </div>

    <div class="admin-modal-observation">
      <span>Observações</span>

      <p>
        ${escaparHTML(observacao)}
      </p>
    </div>
  `;

  renderizarAcoesModal(agendamento);

  elements.modal.hidden = false;

  document.body.style.overflow = "hidden";
}

function fecharModal() {
  elements.modal.hidden = true;

  elements.modalContent.innerHTML = "";
  elements.modalActions.innerHTML = "";

  agendamentoSelecionadoId = null;

  document.body.style.overflow = "";
}

function criarBotaoModal({ label, action, variant }) {
  return `
    <button
      type="button"
      class="admin-modal-button admin-modal-button--${variant}"
      data-modal-action="${action}"
    >
      ${escaparHTML(label)}
    </button>
  `;
}

function renderizarAcoesModal(agendamento) {
  const status = normalizarStatus(agendamento.status);

  const grupo = obterGrupoStatus(status);

  const finalizado = grupo === "concluidos" || grupo === "cancelados";

  const acoes = [];

  acoes.push(
    criarBotaoModal({
      label: "Falar com a cliente no WhatsApp",
      action: "whatsapp",
      variant: "whatsapp",
    }),
  );

  /*
   * O botão Confirmar aparece somente em
   * agendamentos novos que aguardam ação.
   *
   * Reagendado já é considerado confirmado.
   */
  if (status === "agendado") {
    acoes.push(
      criarBotaoModal({
        label: "Confirmar agendamento",
        action: "confirmar",
        variant: "primary",
      }),
    );
  }

  if (!finalizado) {
    acoes.push(
      criarBotaoModal({
        label: "Reagendar atendimento",
        action: "reagendar",
        variant: "warning",
      }),
    );

    acoes.push(
      criarBotaoModal({
        label: "Concluir atendimento",
        action: "concluir",
        variant: "success",
      }),
    );

    acoes.push(
      criarBotaoModal({
        label: "Cancelar agendamento",
        action: "cancelar",
        variant: "danger",
      }),
    );
  }

  acoes.push(
    criarBotaoModal({
      label: "Fechar detalhes",
      action: "fechar",
      variant: "secondary",
    }),
  );

  elements.modalActions.innerHTML = acoes.join("");
}

/* ============================================================
   WHATSAPP
   ============================================================ */

function formatarTelefoneWhatsApp(telefone) {
  let numeros = String(telefone || "").replace(/\D/g, "");

  if (!numeros) {
    return "";
  }

  if (numeros.length === 10 || numeros.length === 11) {
    numeros = `55${numeros}`;
  }

  return numeros;
}

function abrirWhatsApp(agendamento) {
  const telefone = formatarTelefoneWhatsApp(obterTelefoneCliente(agendamento));

  if (!telefone) {
    window.alert("Essa cliente não possui telefone cadastrado.");

    return;
  }

  const nomeCliente = obterNomeCliente(agendamento);

  const servico = obterServico(agendamento);

  const data = formatarDataVisual(obterData(agendamento));

  const horario = obterHorario(agendamento);

  const mensagem = encodeURIComponent(
    `Olá, ${nomeCliente}! Aqui é a Isabele Mariana Nails. Estou entrando em contato sobre seu agendamento de ${servico}, marcado para ${data} às ${horario}.`,
  );

  window.open(
    `https://wa.me/${telefone}?text=${mensagem}`,
    "_blank",
    "noopener,noreferrer",
  );
}

/* ============================================================
   EVENTOS DE NOTIFICAÇÃO
   ============================================================ */

async function registrarEventoNotificacao(tipo, agendamento) {
  const clienteId = obterPrimeiroValor(
    agendamento,
    ["clienteId", "idCliente", "userId", "uidCliente"],
    null,
  );

  if (!clienteId) {
    console.warn(
      "Agendamento sem clienteId. Notificação não registrada:",
      agendamento.id,
    );

    return;
  }

  const payload = {
    tipo,
    clienteId,
    agendamentoId: agendamento.id,

    processado: false,

    timestamp: new Date().toISOString(),

    criadoEm: serverTimestamp(),
  };

  try {
    await addDoc(collection(db, "eventos_notificacao"), payload);
  } catch (error) {
    console.error("Erro ao registrar evento de notificação:", error);
  }

  if (!webhookUrl) {
    return;
  }

  fetch(webhookUrl, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      ...payload,
      criadoEm: undefined,
    }),
  }).catch((error) => {
    console.warn("Erro ao comunicar webhook:", error);
  });
}

/* ============================================================
   ATUALIZAÇÕES
   ============================================================ */

async function atualizarAgendamento(id, atualizacoes) {
  const agendamentoRef = doc(db, "agendamentos", id);

  await updateDoc(agendamentoRef, {
    ...atualizacoes,

    atualizadoEm: serverTimestamp(),

    atualizadoPor: auth.currentUser?.uid || null,
  });

  const indice = todosAgendamentos.findIndex(
    (agendamento) => agendamento.id === id,
  );

  if (indice >= 0) {
    todosAgendamentos[indice] = {
      ...todosAgendamentos[indice],
      ...atualizacoes,
    };
  }

  ordenarAgendamentos();
  atualizarResumo();
  atualizarContadoresFiltros();
  aplicarFiltros();
}

async function confirmarAgendamento(agendamento) {
  const confirmou = window.confirm(
    `Confirmar o agendamento de ${obterNomeCliente(agendamento)}?`,
  );

  if (!confirmou) {
    return;
  }

  try {
    await atualizarAgendamento(agendamento.id, {
      status: "confirmado",

      confirmadoEm: serverTimestamp(),
    });

    fecharModal();

    window.alert("Agendamento confirmado com sucesso.");
  } catch (error) {
    console.error("Erro ao confirmar agendamento:", error);

    window.alert("Não foi possível confirmar o agendamento.");
  }
}

async function concluirAgendamento(agendamento) {
  const nomeCliente = obterNomeCliente(agendamento);

  const valorSugerido = obterValorSugeridoAgendamento(agendamento);

  const valorInformado = window.prompt(
    `Informe o valor final cobrado no atendimento de ${nomeCliente}:`,
    valorSugerido > 0 ? valorSugerido.toFixed(2).replace(".", ",") : "",
  );

  if (valorInformado === null) {
    return;
  }

  const valorFinal = converterValorMonetario(valorInformado);

  if (valorFinal <= 0) {
    window.alert("Informe um valor final válido.");

    return;
  }

  const confirmou = window.confirm(
    `Concluir o atendimento de ${nomeCliente} por ${formatarValorMonetario(valorFinal)}?`,
  );

  if (!confirmou) {
    return;
  }

  try {
    await atualizarAgendamento(agendamento.id, {
      status: "concluido",

      valorFinal,

      concluidoEm: serverTimestamp(),
    });

    fecharModal();

    window.alert("Atendimento concluído com sucesso.");
  } catch (error) {
    console.error("Erro ao concluir atendimento:", error);

    window.alert("Não foi possível concluir o atendimento.");
  }
}

async function cancelarAgendamento(agendamento) {
  const confirmou = window.confirm(
    `Cancelar o agendamento de ${obterNomeCliente(agendamento)}?`,
  );

  if (!confirmou) {
    return;
  }

  const calendarEventId = String(agendamento.calendarEventId || "").trim();

  try {
    await atualizarAgendamento(agendamento.id, {
      status: "cancelado_profissional",

      canceladoEm: serverTimestamp(),
    });

    await registrarEventoNotificacao("cancelamento_admin", agendamento);

    if (calendarEventId) {
      try {
        await fetch(
          "https://script.google.com/macros/s/AKfycbwUwXunAdMAroSPAeMHH2ZQxCOuQage7lmAHH7-llgmeVXug6-Z9KGq6R7NVgQ70XYy/exec",
          {
            method: "POST",
            mode: "no-cors",
            body: JSON.stringify({
              acao: "CANCELAR",
              eventId: calendarEventId,
            }),
          },
        );
      } catch (erroGas) {
        console.error("Erro ao comunicar cancelamento para o GAS:", erroGas);
      }
    } else {
      console.warn(
        "Agendamento sem calendarEventId. Evento do Google não foi removido.",
      );
    }

    fecharModal();

    window.alert("Agendamento cancelado com sucesso.");
  } catch (error) {
    console.error("Erro ao cancelar agendamento:", error);

    window.alert("Não foi possível cancelar o agendamento.");
  }
}

async function reagendarAgendamento(agendamento) {
  const idServico = String(agendamento.idServico || "").trim();

  if (!idServico) {
    window.alert("Não foi possível identificar o serviço deste agendamento.");

    return;
  }

  const parametros = new URLSearchParams({
    id: idServico,
    reagendar: agendamento.id,
    origem: "admin",
  });

  window.location.href = `agendamento.html?${parametros.toString()}`;
}
/* ============================================================
   EVENTOS DA TELA
   ============================================================ */

function configurarEventos() {
  elements.refreshButton?.addEventListener("click", carregarAgendamentos);

  elements.retryButton?.addEventListener("click", carregarAgendamentos);
  elements.summaryGrid?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-summary-filter]");

    if (!card) {
      return;
    }

    selecionarFiltroResumo(card.dataset.summaryFilter);
  });

  elements.summaryGrid?.addEventListener("keydown", (event) => {
    const card = event.target.closest("[data-summary-filter]");

    if (!card) {
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    card.click();
  });
  elements.searchForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    buscaAtual = elements.searchInput.value.trim();

    aplicarFiltros();
  });

  elements.searchInput?.addEventListener("input", () => {
    buscaAtual = elements.searchInput.value.trim();

    aplicarFiltros();
  });

  elements.dateFilter?.addEventListener("change", () => {
    dataFiltroAtual = elements.dateFilter.value;

    /*
     * Uma data personalizada passa a controlar
     * a lista, então removemos o filtro superior.
     */
    filtroResumoAtivo = null;

    atualizarEstadoCardsResumo();
    aplicarFiltros();
  });

  elements.statusFilters?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-status-filter]");

    if (!button) {
      return;
    }

    /*
     * Ao clicar nos filtros inferiores,
     * saímos do filtro rápido superior.
     */
    filtroResumoAtivo = null;

    filtroStatusAtivo = button.dataset.statusFilter || "todos";

    atualizarEstadoCardsResumo();
    atualizarEstadoFiltrosStatus();
    aplicarFiltros();
  });

  elements.clearFiltersButton?.addEventListener("click", limparFiltros);

  elements.list?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");

    if (!button) {
      return;
    }

    const id = button.dataset.id;

    const agendamento = encontrarAgendamento(id);

    if (!agendamento) {
      return;
    }

    if (button.dataset.action === "detalhes") {
      abrirModal(id);
    }

    if (button.dataset.action === "whatsapp") {
      abrirWhatsApp(agendamento);
    }
  });

  elements.modal?.addEventListener("click", async (event) => {
    if (event.target.closest("[data-close-modal]")) {
      fecharModal();
      return;
    }

    const button = event.target.closest("[data-modal-action]");

    if (!button) {
      return;
    }

    const agendamento = encontrarAgendamento(agendamentoSelecionadoId);

    if (!agendamento) {
      fecharModal();
      return;
    }

    const action = button.dataset.modalAction;

    if (action === "fechar") {
      fecharModal();
      return;
    }

    button.disabled = true;

    try {
      if (action === "whatsapp") {
        abrirWhatsApp(agendamento);
      }

      if (action === "confirmar") {
        await confirmarAgendamento(agendamento);
      }

      if (action === "reagendar") {
        await reagendarAgendamento(agendamento);
      }

      if (action === "concluir") {
        await concluirAgendamento(agendamento);
      }

      if (action === "cancelar") {
        await cancelarAgendamento(agendamento);
      }
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.modal.hidden) {
      fecharModal();
    }
  });
}

function limparFiltros() {
  /*
   * O estado inicial da tela passa a ser
   * sempre Agendamentos hoje.
   */
  filtroResumoAtivo = "hoje";
  filtroStatusAtivo = "todos";

  buscaAtual = "";
  dataFiltroAtual = "";

  elements.searchInput.value = "";
  elements.dateFilter.value = "";

  atualizarEstadoCardsResumo();
  atualizarEstadoFiltrosStatus();
  aplicarFiltros();
}

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */

function atualizarDataAtual() {
  const hoje = new Date();

  elements.currentDate.textContent = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
  })
    .format(hoje)
    .replace(".", "");
}

function iniciarPagina() {
  carregarElementos();
  configurarEventos();
  atualizarDataAtual();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");

      return;
    }

    try {
      const autorizado = await verificarAcessoAdmin(user);

      if (!autorizado) {
        mostrarAcessoNegado(
          "Acesso não autorizado",
          "Esta conta não possui permissão para acessar a gestão de agendamentos.",
        );

        return;
      }

      liberarConteudoAdmin();

      await carregarAgendamentos();
    } catch (error) {
      console.error("Erro ao verificar acesso administrativo:", error);

      mostrarAcessoNegado(
        "Não foi possível verificar o acesso",
        "Verifique sua conexão e tente abrir a página novamente.",
      );
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", iniciarPagina);
} else {
  iniciarPagina();
}
