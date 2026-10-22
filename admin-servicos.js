import { auth, db } from "./firebase-config.js";
import { categoriaPossuiServicos, nomeCategoriaDuplicado } from "./categoriasCatalogo.mjs";
import { calcularSinalServico, criarCamposSinalServico, formatarSinalServico, obterEntradaSinalServico } from "./infra/backend/src/pixSinalServico.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

/* ============================================================
   ESTADO DA PÁGINA
   ============================================================ */

let todosServicos = [];
let servicosFiltrados = [];
let categoriasDisponiveis = [];

let filtroResumoAtivo = "todos";
let buscaAtual = "";
let categoriaAtual = "todas";

let servicoEmEdicaoId = null;
let servicoParaExcluirId = null;

let carregamentoEmAndamento = false;
let salvamentoEmAndamento = false;
let exclusaoEmAndamento = false;

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

  elements.content = document.getElementById("admin-servicos-content");

  elements.newServiceButton = document.getElementById(
    "admin-new-service-button",
  );

  elements.addServiceButton = document.getElementById(
    "admin-add-service-button",
  );
  elements.manageCategoriesButton = document.getElementById("admin-manage-categories-button");
  elements.categoriesModal = document.getElementById("admin-categories-modal");
  elements.categoryForm = document.getElementById("admin-category-form");
  elements.categoryId = document.getElementById("admin-category-id");
  elements.categoryName = document.getElementById("admin-category-name");
  elements.categoryDescription = document.getElementById("admin-category-description");
  elements.categoryActive = document.getElementById("admin-category-active");
  elements.categorySubmit = document.getElementById("admin-category-submit");
  elements.categoryCancelEdit = document.getElementById("admin-category-cancel-edit");
  elements.categoriesList = document.getElementById("admin-categories-list");
  elements.categoryFeedback = document.getElementById("admin-category-feedback");

  elements.summary = document.getElementById("admin-services-summary");

  elements.totalServices = document.getElementById("admin-total-services");

  elements.activeServices = document.getElementById("admin-active-services");

  elements.inactiveServices = document.getElementById(
    "admin-inactive-services",
  );

  elements.servicesWithoutPrice = document.getElementById(
    "admin-services-without-price",
  );

  elements.results = document.getElementById("admin-services-results");

  elements.searchForm = document.getElementById("admin-services-search-form");

  elements.searchInput = document.getElementById("admin-services-search-input");

  elements.categoryFilter = document.getElementById(
    "admin-services-category-filter",
  );

  elements.loading = document.getElementById("admin-services-loading");

  elements.list = document.getElementById("admin-services-list");

  elements.empty = document.getElementById("admin-services-empty");

  elements.emptyTitle = document.getElementById("admin-services-empty-title");

  elements.emptyMessage = document.getElementById(
    "admin-services-empty-message",
  );

  elements.clearFiltersButton = document.getElementById(
    "admin-services-clear-filters",
  );

  elements.error = document.getElementById("admin-services-error");

  elements.retryButton = document.getElementById("admin-services-retry-button");

  elements.serviceModal = document.getElementById("admin-service-modal");

  elements.serviceModalTitle = document.getElementById(
    "admin-service-modal-title",
  );

  elements.serviceForm = document.getElementById("admin-service-form");

  elements.serviceId = document.getElementById("admin-service-id");

  elements.serviceName = document.getElementById("admin-service-name");

  elements.serviceCategory = document.getElementById("admin-service-category");

  elements.servicePrice = document.getElementById("admin-service-price");

  elements.pixSignalType = document.getElementById("admin-service-pix-signal-type");
  elements.pixSignalValueField = document.getElementById("admin-service-pix-signal-value-field");
  elements.pixSignalValue = document.getElementById("admin-service-pix-signal-value");
  elements.pixSignalValueLabel = document.getElementById("admin-service-pix-signal-value-label");
  elements.pixSignalValueHelp = document.getElementById("admin-service-pix-signal-value-help");
  elements.pixSignalPreview = document.getElementById("admin-service-pix-signal-preview");

  elements.serviceDuration = document.getElementById("admin-service-duration");

  elements.serviceDescription = document.getElementById(
    "admin-service-description",
  );
  elements.serviceKeywords = document.getElementById("admin-service-keywords");

  elements.serviceActive = document.getElementById("admin-service-active");

  elements.serviceSubmitButton = document.getElementById(
    "admin-service-submit-button",
  );

  elements.deleteModal = document.getElementById("admin-delete-service-modal");

  elements.deleteMessage = document.getElementById(
    "admin-delete-service-message",
  );

  elements.confirmDeleteButton = document.getElementById(
    "admin-confirm-delete-service",
  );
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

function criarSlug(valor) {
  return normalizarTexto(valor)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function formatarNomePorSlug(slug) {
  const nomesConhecidos = {
    "unhas-em-gel": "Unhas em Gel",
    manicure: "Manicure",
    pedicure: "Pedicure",
  };

  if (nomesConhecidos[slug]) {
    return nomesConhecidos[slug];
  }

  return String(slug || "Sem categoria")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letra) => letra.toUpperCase());
}

function normalizarCategoria(valor) {
  const categoria = String(valor || "").trim();

  if (!categoria) {
    return "sem-categoria";
  }

  return criarSlug(categoria);
}

function encontrarCategoriaLegada(slug) {
  return categoriasDisponiveis.find((categoria) =>
    categoria.slug === slug || categoria.legacySlugs.includes(slug),
  ) || null;
}

/* ============================================================
   PREÇO
   ============================================================ */

function converterPrecoParaNumero(valor) {
  if (valor === null || valor === undefined || valor === "") {
    return 0;
  }

  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : 0;
  }

  let texto = String(valor).trim().replace(/\s/g, "").replace("R$", "");

  if (!texto) {
    return 0;
  }

  if (texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  }

  texto = texto.replace(/[^0-9.-]/g, "");

  const numero = Number(texto);

  return Number.isFinite(numero) ? numero : 0;
}

function formatarPreco(valor) {
  const preco = converterPrecoParaNumero(valor);

  if (preco <= 0) {
    return "Não definido";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(preco);
}

function formatarPrecoParaCampo(valor) {
  const preco = converterPrecoParaNumero(valor);

  if (preco <= 0) {
    return "";
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(preco);
}

/* ============================================================
   DURAÇÃO
   ============================================================ */

function converterDuracaoParaNumero(valor) {
  const numero = Number(valor);

  if (!Number.isFinite(numero) || numero <= 0) {
    return 60;
  }

  return Math.round(numero);
}

function formatarDuracao(valor) {
  const minutos = converterDuracaoParaNumero(valor);

  if (minutos < 60) {
    return `${minutos} min`;
  }

  const horas = Math.floor(minutos / 60);

  const minutosRestantes = minutos % 60;

  if (minutosRestantes === 0) {
    return horas === 1 ? "1 hora" : `${horas} horas`;
  }

  return `${horas}h ${minutosRestantes}min`;
}

/* ============================================================
   NORMALIZAÇÃO DOS SERVIÇOS
   ============================================================ */

function normalizarServico(documentSnapshot) {
  const dados = documentSnapshot.data();

  const nome = String(
    obterPrimeiroValor(
      dados,
      ["nome", "nomeServico", "servico", "titulo"],
      "Serviço sem nome",
    ),
  ).trim();

  const categoria = normalizarCategoria(
    obterPrimeiroValor(
      dados,
      ["categoria", "categoriaSlug", "tipo"],
      "sem-categoria",
    ),
  );
  const categoriaEncontrada = dados.categoriaId
    ? categoriasDisponiveis.find((item) => item.id === dados.categoriaId)
    : encontrarCategoriaLegada(categoria);

  const preco = converterPrecoParaNumero(
    obterPrimeiroValor(dados, ["preco", "valor", "valorReferencia"], 0),
  );

  const duracao = converterDuracaoParaNumero(
    obterPrimeiroValor(dados, ["duracao", "duracaoMinutos", "tempo"], 60),
  );

  const descricao = String(
    obterPrimeiroValor(dados, ["descricao", "descrição", "resumo"], ""),
  ).trim();

  const status = normalizarTexto(dados.status);

  const statusInativo = [
    "inativo",
    "inactive",
    "desativado",
    "disabled",
  ].includes(status);

  const ativo = dados.ativo !== false && !statusInativo;

  return {
    id: documentSnapshot.id,

    nome,
    categoria,
    categoriaId: categoriaEncontrada?.id || dados.categoriaId || "",
    categoriaNome: categoriaEncontrada?.nome || formatarNomePorSlug(categoria),
    preco,
    duracao,
    descricao,
    palavrasChave: Array.isArray(dados.palavrasChave) ? dados.palavrasChave : [],
    ativo,
    pixSinalTipo: dados.pixSinalTipo || null,
    pixSinalValorCentavos: dados.pixSinalValorCentavos ?? null,
    pixSinalPercentual: dados.pixSinalPercentual ?? null,

    criadoEm: dados.criadoEm || null,

    atualizadoEm: dados.atualizadoEm || null,

    dadosOriginais: dados,
  };
}

function encontrarServico(id) {
  return todosServicos.find((servico) => servico.id === id);
}

/* ============================================================
   ACESSO ADMINISTRATIVO
   ============================================================ */

async function verificarAcessoAdmin(user) {
  const usuarioReference = doc(db, "usuarios", user.uid);

  const usuarioSnapshot = await getDoc(usuarioReference);

  if (!usuarioSnapshot.exists()) {
    return false;
  }

  const usuario = usuarioSnapshot.data();

  return (
    String(usuario.role || "")
      .trim()
      .toLowerCase() === "admin" && usuario.ativo === true
  );
}

function liberarConteudo() {
  elements.body.dataset.accessState = "allowed";

  elements.accessLoading.hidden = true;
  elements.accessError.hidden = true;
  elements.content.hidden = false;

  elements.newServiceButton.disabled = false;
}

function mostrarAcessoNegado(titulo, mensagem) {
  elements.body.dataset.accessState = "denied";

  elements.accessLoading.hidden = true;
  elements.content.hidden = true;
  elements.accessError.hidden = false;

  elements.accessErrorTitle.textContent = titulo;

  elements.accessErrorMessage.textContent = mensagem;
}

/* ============================================================
   CATEGORIAS
   ============================================================ */

function atualizarOpcoesCategorias() {
  const ordenar = [...categoriasDisponiveis].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  const preencher = (select, rotuloInicial) => {
    if (!select) return;
    const valorAtual = select.value;
    select.replaceChildren(new Option(rotuloInicial, rotuloInicial === "Todas" ? "todas" : ""));
    ordenar.forEach((categoria) => {
      const option = new Option(`${categoria.nome}${categoria.ativo ? "" : " (inativa)"}`, categoria.id);
      select.add(option);
    });
    if (Array.from(select.options).some((option) => option.value === valorAtual)) select.value = valorAtual;
  };
  preencher(elements.categoryFilter, "Todas");
  preencher(elements.serviceCategory, "Selecione");
}

function normalizarDocumentoCategoria(snapshot) {
  const dados = snapshot.data() || {};
  const nome = String(dados.nome || formatarNomePorSlug(dados.slug || "")).trim();
  const status = String(dados.status || (dados.ativo === false ? "inativo" : "ativo")).toLowerCase();
  return {
    id: snapshot.id,
    nome,
    slug: normalizarCategoria(dados.slug || nome),
    descricao: String(dados.descricao || "").trim(),
    ativo: dados.ativo !== false && !["inativo", "inactive", "desativado", "disabled"].includes(status),
    legacySlugs: Array.isArray(dados.legacySlugs) ? dados.legacySlugs.map(normalizarCategoria) : [],
    criadoEm: dados.criadoEm || null,
    atualizadoEm: dados.atualizadoEm || null,
    persistida: true,
  };
}

async function carregarCategorias(servicosSnapshot) {
  const snapshot = await getDocs(collection(db, "categorias"));
  categoriasDisponiveis = snapshot.docs.map(normalizarDocumentoCategoria);

  // Serviços antigos continuam vinculados por slug sem gravar migrações automáticas.
  const slugsLegados = new Set(["manicure", "pedicure", "unhas-em-gel"]);
  servicosSnapshot.docs.forEach((servicoSnap) => {
    const dados = servicoSnap.data() || {};
    const slug = normalizarCategoria(dados.categoria || dados.categoriaSlug || dados.tipo || "");
    if (slug && slug !== "sem-categoria" && !dados.categoriaId) slugsLegados.add(slug);
  });
  for (const slug of slugsLegados) {
    if (encontrarCategoriaLegada(slug)) continue;
    categoriasDisponiveis.push({
      id: `legacy_${slug}`, nome: formatarNomePorSlug(slug), slug,
      descricao: "", ativo: true, legacySlugs: [slug], persistida: false,
    });
  }
  atualizarOpcoesCategorias();
  renderizarCategoriasAdmin();
}

function contarServicosCategoria(categoria) {
  return todosServicos.filter((servico) => categoriaPossuiServicos(categoria, [servico])).length;
}

function renderizarCategoriasAdmin() {
  if (!elements.categoriesList) return;
  elements.categoriesList.replaceChildren();
  const categorias = [...categoriasDisponiveis].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  if (!categorias.length) {
    elements.categoriesList.innerHTML = '<p class="admin-category-empty">Nenhuma categoria cadastrada.</p>';
    return;
  }
  categorias.forEach((categoria) => {
    const quantidade = contarServicosCategoria(categoria);
    const item = document.createElement("article");
    item.className = "admin-category-item";
    item.innerHTML = `<div class="admin-category-item-copy"><strong>${escaparHTML(categoria.nome)}</strong><span>${quantidade} ${quantidade === 1 ? "serviço vinculado" : "serviços vinculados"} · ${categoria.ativo ? "Ativa" : "Inativa"}</span>${categoria.descricao ? `<small>${escaparHTML(categoria.descricao)}</small>` : ""}</div><div class="admin-category-item-actions"><button type="button" data-category-action="edit" data-category-id="${escaparHTML(categoria.id)}">Editar</button><button type="button" data-category-action="toggle" data-category-id="${escaparHTML(categoria.id)}">${categoria.ativo ? "Desativar" : "Ativar"}</button><button type="button" data-category-action="delete" data-category-id="${escaparHTML(categoria.id)}" ${quantidade ? "disabled title=\"Remova os serviços vinculados antes de excluir\"" : ""}>Excluir</button></div>`;
    elements.categoriesList.appendChild(item);
  });
}

function limparFormularioCategoria() {
  elements.categoryForm?.reset();
  elements.categoryId.value = "";
  elements.categoryActive.checked = true;
  elements.categorySubmit.textContent = "Adicionar categoria";
  elements.categoryCancelEdit.hidden = true;
}

function abrirEdicaoCategoria(id) {
  const categoria = categoriasDisponiveis.find((item) => item.id === id);
  if (!categoria) return;
  elements.categoryId.value = categoria.id;
  elements.categoryName.value = categoria.nome;
  elements.categoryDescription.value = categoria.descricao;
  elements.categoryActive.checked = categoria.ativo;
  elements.categorySubmit.textContent = "Salvar alterações";
  elements.categoryCancelEdit.hidden = false;
  elements.categoryName.focus();
}

async function salvarCategoria(event) {
  event.preventDefault();
  const nome = elements.categoryName.value.trim().replace(/\s+/g, " ");
  const slug = criarSlug(nome);
  const descricao = elements.categoryDescription.value.trim();
  const idAtual = elements.categoryId.value;
  if (!nome || !slug) {
    elements.categoryFeedback.textContent = "Informe um nome válido para a categoria.";
    elements.categoryName.focus();
    return;
  }
  if (nomeCategoriaDuplicado(categoriasDisponiveis, slug, idAtual)) {
    elements.categoryFeedback.textContent = "Já existe uma categoria com esse nome.";
    elements.categoryName.focus();
    return;
  }
  elements.categorySubmit.disabled = true;
  elements.categoryFeedback.textContent = "Salvando categoria…";
  try {
    const slugQuery = query(collection(db, "categorias"), where("slug", "==", slug));
    const categoriaAtual = categoriasDisponiveis.find((item) => item.id === idAtual);
    const refAtual = idAtual && categoriaAtual?.persistida ? doc(db, "categorias", idAtual) : doc(collection(db, "categorias"));
    const encontrados = await getDocs(slugQuery);
    if (encontrados.docs.some((item) => item.id !== idAtual)) {
      throw new Error("Já existe uma categoria com esse nome.");
    }
    await runTransaction(db, async (transaction) => {
      const agora = serverTimestamp();
      if (idAtual && categoriaAtual?.persistida) {
        const snapshot = await transaction.get(refAtual);
        if (!snapshot.exists()) throw new Error("A categoria não foi encontrada. Atualize a página e tente novamente.");
        const atual = snapshot.data();
        const aliases = [...new Set([...(Array.isArray(atual.legacySlugs) ? atual.legacySlugs : []), normalizarCategoria(atual.slug || atual.nome)])];
        transaction.update(refAtual, {
          nome, slug, descricao, legacySlugs: aliases,
          ativo: elements.categoryActive.checked,
          status: elements.categoryActive.checked ? "ativo" : "inativo",
          atualizadoEm: agora, atualizadoPor: auth.currentUser?.uid || null,
        });
      } else {
        transaction.set(refAtual, {
          nome, slug, descricao, legacySlugs: [...new Set([...(categoriaAtual?.legacySlugs || []), ...(categoriaAtual?.slug ? [categoriaAtual.slug] : [])])],
          ativo: elements.categoryActive.checked,
          status: elements.categoryActive.checked ? "ativo" : "inativo",
          criadoEm: agora, atualizadoEm: agora,
          criadoPor: auth.currentUser?.uid || null, atualizadoPor: auth.currentUser?.uid || null,
        });
      }
    });
    elements.categoryFeedback.textContent = "Categoria salva com sucesso.";
    limparFormularioCategoria();
    await carregarServicos();
  } catch (error) {
    console.error("Erro ao salvar categoria:", error);
    elements.categoryFeedback.textContent = error.message?.includes("Já existe")
      ? error.message
      : "Não foi possível salvar a categoria. Verifique sua conexão e tente novamente.";
  } finally {
    elements.categorySubmit.disabled = false;
  }
}

async function alternarCategoria(id) {
  const categoria = categoriasDisponiveis.find((item) => item.id === id);
  if (!categoria) return;
  try {
    const ativo = !categoria.ativo;
    if (categoria.persistida) {
      await updateDoc(doc(db, "categorias", id), {
        ativo, status: ativo ? "ativo" : "inativo", atualizadoEm: serverTimestamp(),
        atualizadoPor: auth.currentUser?.uid || null,
      });
    } else {
      const novoRef = doc(collection(db, "categorias"));
      await setDoc(novoRef, {
        nome: categoria.nome, slug: categoria.slug, descricao: categoria.descricao || "",
        legacySlugs: categoria.legacySlugs, ativo, status: ativo ? "ativo" : "inativo",
        criadoEm: serverTimestamp(), atualizadoEm: serverTimestamp(),
        criadoPor: auth.currentUser?.uid || null, atualizadoPor: auth.currentUser?.uid || null,
      });
    }
    await carregarServicos();
    elements.categoryFeedback.textContent = `Categoria ${ativo ? "ativada" : "desativada"}.`;
  } catch (error) {
    console.error("Erro ao alterar categoria:", error);
    elements.categoryFeedback.textContent = "Não foi possível alterar o estado da categoria.";
  }
}

async function excluirCategoria(id) {
  const categoria = categoriasDisponiveis.find((item) => item.id === id);
  if (!categoria) return;
  try {
    const snapshot = await getDocs(collection(db, "servicos"));
    const emUso = categoriaPossuiServicos(categoria, snapshot.docs.map((item) => item.data() || {}));
    if (emUso) {
      elements.categoryFeedback.textContent = "Esta categoria possui serviços vinculados e não pode ser excluída.";
      await carregarServicos();
      return;
    }
    if (!window.confirm(`Excluir a categoria “${categoria.nome}”?`)) return;
    if (!categoria.persistida) {
      elements.categoryFeedback.textContent = "Categorias antigas ligadas a serviços não podem ser removidas.";
      return;
    }
    await deleteDoc(doc(db, "categorias", id));
    elements.categoryFeedback.textContent = "Categoria excluída.";
    await carregarServicos();
  } catch (error) {
    console.error("Erro ao excluir categoria:", error);
    elements.categoryFeedback.textContent = "Não foi possível excluir a categoria. Tente novamente.";
  }
}

function abrirModalCategorias() {
  elements.categoryFeedback.textContent = "";
  renderizarCategoriasAdmin();
  elements.categoriesModal.hidden = false;
  bloquearRolagemPagina();
  elements.categoryName.focus();
}

function fecharModalCategorias() {
  if (elements.categoriesModal.hidden) return;
  elements.categoriesModal.hidden = true;
  limparFormularioCategoria();
  liberarRolagemPagina();
}

/* ============================================================
   CARREGAMENTO
   ============================================================ */

function mostrarCarregamento() {
  elements.loading.hidden = false;
  elements.list.hidden = true;
  elements.empty.hidden = true;
  elements.error.hidden = true;
}

function mostrarErroCarregamento() {
  elements.loading.hidden = true;
  elements.list.hidden = true;
  elements.empty.hidden = true;
  elements.error.hidden = false;
}

async function carregarServicos() {
  if (carregamentoEmAndamento) {
    return;
  }

  carregamentoEmAndamento = true;

  mostrarCarregamento();

  try {
    const snapshot = await getDocs(collection(db, "servicos"));
    await carregarCategorias(snapshot);

    todosServicos = snapshot.docs.map(normalizarServico);

    todosServicos.sort((servicoA, servicoB) => {
      if (servicoA.ativo !== servicoB.ativo) {
        return servicoA.ativo ? -1 : 1;
      }

      return servicoA.nome.localeCompare(servicoB.nome, "pt-BR");
    });

    atualizarOpcoesCategorias();
    renderizarCategoriasAdmin();
    atualizarResumo();
    aplicarFiltros();
  } catch (error) {
    console.error("Erro ao carregar serviços:", error);

    mostrarErroCarregamento();
  } finally {
    carregamentoEmAndamento = false;
  }
}

/* ============================================================
   RESUMO E FILTROS
   ============================================================ */

function atualizarResumo() {
  const total = todosServicos.length;

  const ativos = todosServicos.filter((servico) => servico.ativo).length;

  const inativos = todosServicos.filter((servico) => !servico.ativo).length;

  const semPreco = todosServicos.filter((servico) => servico.preco <= 0).length;

  elements.totalServices.textContent = total;

  elements.activeServices.textContent = ativos;

  elements.inactiveServices.textContent = inativos;

  elements.servicesWithoutPrice.textContent = semPreco;
}

function atualizarEstadoCardsResumo() {
  document.querySelectorAll("[data-summary-filter]").forEach((card) => {
    const ativo = card.dataset.summaryFilter === filtroResumoAtivo;

    card.classList.toggle("is-active", ativo);

    card.setAttribute("aria-pressed", String(ativo));
  });
}

function aplicarFiltros() {
  const buscaNormalizada = normalizarTexto(buscaAtual);

  servicosFiltrados = todosServicos.filter((servico) => {
    let combinaResumo = true;

    if (filtroResumoAtivo === "ativos") {
      combinaResumo = servico.ativo;
    }

    if (filtroResumoAtivo === "inativos") {
      combinaResumo = !servico.ativo;
    }

    if (filtroResumoAtivo === "sem-preco") {
      combinaResumo = servico.preco <= 0;
    }

    const combinaCategoria =
      categoriaAtual === "todas" || servico.categoriaId === categoriaAtual;

    const textoPesquisavel = normalizarTexto(`
            ${servico.nome}
            ${servico.categoriaNome}
            ${servico.categoria}
            ${formatarNomePorSlug(servico.categoria)}
            ${servico.descricao}
          `);

    const combinaBusca =
      !buscaNormalizada || textoPesquisavel.includes(buscaNormalizada);

    return combinaResumo && combinaCategoria && combinaBusca;
  });

  renderizarLista();
}

/* ============================================================
   ÍCONES
   ============================================================ */

function obterIconePreco() {
  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3V21"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      ></path>

      <path
        d="M16 7.5C16 5.8 14.3 5 12 5C9.7 5 8 6 8 8C8 12 16 10 16 15C16 17.4 14.2 19 12 19C9.8 19 8 18 8 16"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      ></path>
    </svg>
  `;
}

function obterIconeDuracao() {
  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
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

function obterIconeEditar() {
  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 20H8L18.5 9.5C19.3 8.7 19.3 7.3 18.5 6.5L17.5 5.5C16.7 4.7 15.3 4.7 14.5 5.5L4 16V20Z"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      ></path>

      <path
        d="M13 7L17 11"
        stroke="currentColor"
        stroke-width="1.8"
      ></path>
    </svg>
  `;
}

function obterIconeStatus(ativo) {
  if (ativo) {
    return `
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M12 3V12"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        ></path>

        <path
          d="M7.2 6.8A8 8 0 1 0 16.8 6.8"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        ></path>
      </svg>
    `;
  }

  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="1.8"
      ></circle>

      <path
        d="M8 12L11 15L16 9"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
    </svg>
  `;
}

function obterIconeExcluir() {
  return `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 7H19"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      ></path>

      <path
        d="M9 7V4H15V7"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      ></path>

      <path
        d="M7 7L8 20H16L17 7"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      ></path>
    </svg>
  `;
}

/* ============================================================
   CARDS
   ============================================================ */

function criarCardServico(servico) {
  const categoriaVisual = servico.categoriaNome || formatarNomePorSlug(servico.categoria);

  const statusVisual = servico.ativo ? "Ativo" : "Inativo";

  const statusClasse = servico.ativo ? "ativo" : "inativo";

  const descricao =
    servico.descricao || "Nenhuma descrição cadastrada para este serviço.";

  const textoToggle = servico.ativo ? "Desativar serviço" : "Ativar serviço";

  let sinalPix = "Sinal não configurado";
  try {
    sinalPix = formatarSinalServico(servico.dadosOriginais);
  } catch {
    // Serviços antigos sem regra permanecem editáveis, mas não geram PIX.
  }

  return `
    <article
      class="admin-service-card"
      data-service-id="${escaparHTML(servico.id)}"
    >
      <header class="admin-service-card-header">

        <div class="admin-service-card-title">
          <strong>
            ${escaparHTML(servico.nome)}
          </strong>

          <span class="admin-service-category">
            ${escaparHTML(categoriaVisual)}
          </span>
        </div>

        <span
          class="admin-service-status admin-service-status--${statusClasse}"
        >
          ${statusVisual}
        </span>

      </header>

      <p class="admin-service-description">
        ${escaparHTML(descricao)}
      </p>

      <div class="admin-service-meta">

        <div class="admin-service-meta-item">

          <span
            class="admin-service-meta-icon"
            aria-hidden="true"
          >
            ${obterIconePreco()}
          </span>

          <div>
            <span>Preço</span>

            <strong>
              ${escaparHTML(formatarPreco(servico.preco))}
            </strong>
          </div>

        </div>

        <div class="admin-service-meta-item admin-service-meta-item--pix">
          <span class="admin-service-meta-icon" aria-hidden="true">PIX</span>
          <div>
            <span>Sinal para agendamento PIX</span>
            <strong>${escaparHTML(sinalPix)}</strong>
          </div>
        </div>

        <div class="admin-service-meta-item">

          <span
            class="admin-service-meta-icon"
            aria-hidden="true"
          >
            ${obterIconeDuracao()}
          </span>

          <div>
            <span>Duração</span>

            <strong>
              ${escaparHTML(formatarDuracao(servico.duracao))}
            </strong>
          </div>

        </div>

      </div>

      <div class="admin-service-actions">

        <button
          type="button"
          class="admin-service-button admin-service-button--edit"
          data-service-action="editar"
          data-service-id="${escaparHTML(servico.id)}"
        >
          ${obterIconeEditar()}

          Editar serviço
        </button>

        <button
          type="button"
          class="admin-service-button admin-service-button--toggle"
          data-service-action="alternar-status"
          data-service-id="${escaparHTML(servico.id)}"
          aria-label="${escaparHTML(textoToggle)}"
          title="${escaparHTML(textoToggle)}"
        >
          ${obterIconeStatus(servico.ativo)}
        </button>

        <button
          type="button"
          class="admin-service-button admin-service-button--delete"
          data-service-action="excluir"
          data-service-id="${escaparHTML(servico.id)}"
          aria-label="Excluir ${escaparHTML(servico.nome)}"
          title="Excluir serviço"
        >
          ${obterIconeExcluir()}
        </button>

      </div>

    </article>
  `;
}

function renderizarLista() {
  elements.loading.hidden = true;
  elements.error.hidden = true;

  const quantidade = servicosFiltrados.length;

  elements.results.textContent =
    quantidade === 1 ? "1 serviço" : `${quantidade} serviços`;

  if (quantidade === 0) {
    elements.list.hidden = true;
    elements.empty.hidden = false;

    const possuiFiltros =
      filtroResumoAtivo !== "todos" ||
      categoriaAtual !== "todas" ||
      Boolean(buscaAtual);

    if (possuiFiltros) {
      elements.emptyTitle.textContent = "Nenhum serviço encontrado";

      elements.emptyMessage.textContent =
        "Não existem serviços para os filtros selecionados.";

      elements.clearFiltersButton.hidden = false;
    } else {
      elements.emptyTitle.textContent = "Nenhum serviço cadastrado";

      elements.emptyMessage.textContent =
        "Cadastre o primeiro serviço para começar a montar o catálogo.";

      elements.clearFiltersButton.hidden = true;
    }

    return;
  }

  elements.empty.hidden = true;
  elements.list.hidden = false;

  elements.list.innerHTML = servicosFiltrados.map(criarCardServico).join("");
}

/* ============================================================
   MODAL DE CADASTRO E EDIÇÃO
   ============================================================ */

function bloquearRolagemPagina() {
  document.body.style.overflow = "hidden";
}

function liberarRolagemPagina() {
  const possuiModalAberto =
    !elements.serviceModal.hidden || !elements.deleteModal.hidden;

  if (!possuiModalAberto) {
    if (!elements.categoriesModal.hidden) return;
    document.body.style.overflow = "";
  }
}

function limparFormulario() {
  elements.serviceForm.reset();

  elements.serviceId.value = "";
  elements.serviceActive.checked = true;
  elements.pixSignalType.value = "";
  elements.pixSignalValue.value = "";
  atualizarCamposSinalPix();

  servicoEmEdicaoId = null;
}

function abrirModalNovoServico() {
  limparFormulario();

  elements.serviceModalTitle.textContent = "Novo serviço";

  elements.serviceSubmitButton.textContent = "Salvar serviço";

  elements.serviceModal.hidden = false;

  bloquearRolagemPagina();

  window.setTimeout(() => {
    elements.serviceName.focus();
  }, 100);
}

function abrirModalEditarServico(id) {
  const servico = encontrarServico(id);

  if (!servico) {
    return;
  }

  servicoEmEdicaoId = id;

  elements.serviceId.value = servico.id;

  elements.serviceName.value = servico.nome;

  elements.serviceCategory.value = servico.categoriaId;

  elements.servicePrice.value = formatarPrecoParaCampo(servico.preco);

  const sinalEdicao = obterEntradaSinalServico(servico.dadosOriginais);
  elements.pixSignalType.value = sinalEdicao.tipo;
  elements.pixSignalValue.value = sinalEdicao.valor;
  atualizarCamposSinalPix();

  elements.serviceDuration.value = servico.duracao;

  elements.serviceDescription.value = servico.descricao;
  if (elements.serviceKeywords) elements.serviceKeywords.value = (servico.dadosOriginais.palavrasChave || []).join(", ");

  elements.serviceActive.checked = servico.ativo;

  elements.serviceModalTitle.textContent = "Editar serviço";

  elements.serviceSubmitButton.textContent = "Salvar alterações";

  elements.serviceModal.hidden = false;

  bloquearRolagemPagina();

  window.setTimeout(() => {
    elements.serviceName.focus();
  }, 100);
}

function fecharModalServico() {
  if (salvamentoEmAndamento) {
    return;
  }

  elements.serviceModal.hidden = true;

  limparFormulario();
  liberarRolagemPagina();
}

function criarConfiguracaoSinalPix() {
  const tipo = elements.pixSignalType.value;
  if (!tipo) {
    return {
      pixSinalTipo: null,
      pixSinalValorCentavos: null,
      pixSinalPercentual: null,
    };
  }

  return criarCamposSinalServico(
    converterPrecoParaNumero(elements.servicePrice.value),
    tipo,
    elements.pixSignalValue.value,
  );
}

function atualizarCamposSinalPix() {
  const tipo = elements.pixSignalType.value;
  const fixo = tipo === "fixo";
  elements.pixSignalValueField.hidden = !tipo;
  elements.pixSignalValueLabel.textContent = fixo ? "Valor fixo do sinal (R$)" : "Percentual do sinal (%)";
  elements.pixSignalValueHelp.textContent = fixo
    ? "Maior que zero e até o preço do serviço."
    : "Maior que zero e até 100%.";
  elements.pixSignalValue.min = "0.01";
  elements.pixSignalValue.max = fixo ? "" : "100";
  elements.pixSignalValue.step = "0.01";
  atualizarPreviaSinalPix();
}

function atualizarPreviaSinalPix() {
  const resumo = elements.pixSignalPreview.querySelector("span");
  const tipo = elements.pixSignalType.value;
  if (!tipo) {
    resumo.textContent = "Este serviço ainda não tem sinal configurado e não poderá emitir PIX.";
    return;
  }
  try {
    const sinal = criarConfiguracaoSinalPix();
    const valores = calcularSinalServico({
      preco: converterPrecoParaNumero(elements.servicePrice.value),
      ...sinal,
    });
    const moeda = (centavos) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(centavos / 100);
    resumo.textContent = `Sinal: ${moeda(valores.valorSinalCentavos)} · Restante: ${moeda(valores.valorRestanteCentavos)}`;
  } catch (erro) {
    resumo.textContent = erro.message;
  }
}

/* ============================================================
   SALVAR SERVIÇO
   ============================================================ */

function validarFormularioServico() {
  const nome = elements.serviceName.value.trim();

  const categoria = elements.serviceCategory.value;

  const duracao = Number(elements.serviceDuration.value);

  if (!nome) {
    window.alert("Informe o nome do serviço.");

    elements.serviceName.focus();

    return false;
  }

  if (!categoria) {
    window.alert("Selecione a categoria do serviço.");

    elements.serviceCategory.focus();

    return false;
  }

  if (!Number.isFinite(duracao) || duracao < 5) {
    window.alert("Informe uma duração válida a partir de 5 minutos.");

    elements.serviceDuration.focus();

    return false;
  }

  const tipoSinal = elements.pixSignalType.value;
  if (tipoSinal) {
    try {
      criarConfiguracaoSinalPix();
    } catch (erro) {
      window.alert(erro.message);
      elements.pixSignalValue.focus();
      return false;
    }
  }

  return true;
}

function criarPayloadServico() {
  const ativo = elements.serviceActive.checked;
  const configuracaoSinal = criarConfiguracaoSinalPix();
  const categoria = categoriasDisponiveis.find((item) => item.id === elements.serviceCategory.value);

  return {
    nome: elements.serviceName.value.trim(),

    categoria: categoria?.slug || "",
    categoriaId: categoria?.id || "",

    preco: converterPrecoParaNumero(elements.servicePrice.value),

    duracao: converterDuracaoParaNumero(elements.serviceDuration.value),

    descricao: elements.serviceDescription.value.trim(),
    palavrasChave: String(elements.serviceKeywords?.value || "").split(/[;,\n]/).map((termo) => termo.trim()).filter(Boolean).slice(0, 30),

    ...configuracaoSinal,

    ativo,

    status: ativo ? "ativo" : "inativo",

    atualizadoEm: serverTimestamp(),

    atualizadoPor: auth.currentUser?.uid || null,
  };
}

async function salvarServico(event) {
  event.preventDefault();

  if (salvamentoEmAndamento || !validarFormularioServico()) {
    return;
  }

  salvamentoEmAndamento = true;

  const textoOriginal = elements.serviceSubmitButton.textContent;

  elements.serviceSubmitButton.disabled = true;

  elements.serviceSubmitButton.textContent = servicoEmEdicaoId
    ? "Salvando alterações..."
    : "Criando serviço...";

  try {
    const payload = criarPayloadServico();

    if (servicoEmEdicaoId) {
      await updateDoc(doc(db, "servicos", servicoEmEdicaoId), payload);
    } else {
      await addDoc(collection(db, "servicos"), {
        ...payload,

        criadoEm: serverTimestamp(),

        criadoPor: auth.currentUser?.uid || null,
      });
    }

    const mensagem = servicoEmEdicaoId
      ? "Serviço atualizado com sucesso."
      : "Serviço cadastrado com sucesso.";

    elements.serviceModal.hidden = true;
    limparFormulario();
    liberarRolagemPagina();

    await carregarServicos();

    window.alert(mensagem);
  } catch (error) {
    console.error("Erro ao salvar serviço:", error);

    window.alert(
      "Não foi possível salvar o serviço. Verifique os dados e tente novamente.",
    );
  } finally {
    salvamentoEmAndamento = false;

    elements.serviceSubmitButton.disabled = false;

    elements.serviceSubmitButton.textContent = textoOriginal;
  }
}

/* ============================================================
   ATIVAR E DESATIVAR
   ============================================================ */

async function alternarStatusServico(id, button) {
  const servico = encontrarServico(id);

  if (!servico) {
    return;
  }

  const novoStatus = !servico.ativo;

  const acao = novoStatus ? "ativar" : "desativar";

  const confirmou = window.confirm(
    `Deseja ${acao} o serviço “${servico.nome}”?`,
  );

  if (!confirmou) {
    return;
  }

  button.disabled = true;

  try {
    await updateDoc(doc(db, "servicos", servico.id), {
      ativo: novoStatus,

      status: novoStatus ? "ativo" : "inativo",

      atualizadoEm: serverTimestamp(),

      atualizadoPor: auth.currentUser?.uid || null,
    });

    servico.ativo = novoStatus;

    todosServicos.sort((servicoA, servicoB) => {
      if (servicoA.ativo !== servicoB.ativo) {
        return servicoA.ativo ? -1 : 1;
      }

      return servicoA.nome.localeCompare(servicoB.nome, "pt-BR");
    });

    atualizarResumo();
    aplicarFiltros();
  } catch (error) {
    console.error("Erro ao alterar status do serviço:", error);

    window.alert("Não foi possível alterar o status do serviço.");
  } finally {
    button.disabled = false;
  }
}

/* ============================================================
   EXCLUSÃO
   ============================================================ */

function abrirModalExcluirServico(id) {
  const servico = encontrarServico(id);

  if (!servico) {
    return;
  }

  servicoParaExcluirId = id;

  elements.deleteMessage.textContent = `O serviço “${servico.nome}” será removido do catálogo. Essa ação não poderá ser desfeita.`;

  elements.deleteModal.hidden = false;

  bloquearRolagemPagina();
}

function fecharModalExcluir() {
  if (exclusaoEmAndamento) {
    return;
  }

  elements.deleteModal.hidden = true;

  servicoParaExcluirId = null;

  liberarRolagemPagina();
}

async function excluirServico() {
  if (exclusaoEmAndamento || !servicoParaExcluirId) {
    return;
  }

  const servico = encontrarServico(servicoParaExcluirId);

  if (!servico) {
    fecharModalExcluir();
    return;
  }

  exclusaoEmAndamento = true;

  const textoOriginal = elements.confirmDeleteButton.textContent;

  elements.confirmDeleteButton.disabled = true;

  elements.confirmDeleteButton.textContent = "Excluindo...";

  try {
    await deleteDoc(doc(db, "servicos", servico.id));

    elements.deleteModal.hidden = true;
    servicoParaExcluirId = null;

    liberarRolagemPagina();

    await carregarServicos();

    window.alert("Serviço excluído com sucesso.");
  } catch (error) {
    console.error("Erro ao excluir serviço:", error);

    window.alert("Não foi possível excluir o serviço.");
  } finally {
    exclusaoEmAndamento = false;

    elements.confirmDeleteButton.disabled = false;

    elements.confirmDeleteButton.textContent = textoOriginal;
  }
}

/* ============================================================
   FILTROS
   ============================================================ */

function limparFiltros() {
  filtroResumoAtivo = "todos";
  buscaAtual = "";
  categoriaAtual = "todas";

  elements.searchInput.value = "";
  elements.categoryFilter.value = "todas";

  atualizarEstadoCardsResumo();
  aplicarFiltros();
}

/* ============================================================
   EVENTOS
   ============================================================ */

function configurarEventos() {
  elements.newServiceButton?.addEventListener("click", abrirModalNovoServico);

  elements.addServiceButton?.addEventListener("click", abrirModalNovoServico);

  elements.manageCategoriesButton?.addEventListener("click", abrirModalCategorias);
  elements.categoryForm?.addEventListener("submit", salvarCategoria);
  elements.categoryCancelEdit?.addEventListener("click", limparFormularioCategoria);
  elements.categoriesList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-category-action]");
    if (!button) return;
    const { categoryAction: action, categoryId: id } = button.dataset;
    if (!id) return;
    if (action === "edit") abrirEdicaoCategoria(id);
    if (action === "toggle") await alternarCategoria(id);
    if (action === "delete") await excluirCategoria(id);
  });
  document.querySelectorAll("[data-close-categories]").forEach((button) => {
    button.addEventListener("click", fecharModalCategorias);
  });

  elements.retryButton?.addEventListener("click", carregarServicos);

  elements.clearFiltersButton?.addEventListener("click", limparFiltros);

  elements.summary?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-summary-filter]");

    if (!card) {
      return;
    }

    filtroResumoAtivo = card.dataset.summaryFilter || "todos";

    atualizarEstadoCardsResumo();
    aplicarFiltros();
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

  elements.categoryFilter?.addEventListener("change", () => {
    categoriaAtual = elements.categoryFilter.value || "todas";

    aplicarFiltros();
  });

  elements.list?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-service-action]");

    if (!button) {
      return;
    }

    const action = button.dataset.serviceAction;

    const id = button.dataset.serviceId;

    if (!id) {
      return;
    }

    if (action === "editar") {
      abrirModalEditarServico(id);
      return;
    }

    if (action === "alternar-status") {
      await alternarStatusServico(id, button);

      return;
    }

    if (action === "excluir") {
      abrirModalExcluirServico(id);
    }
  });

  elements.serviceForm?.addEventListener("submit", salvarServico);

  elements.servicePrice?.addEventListener("blur", () => {
    const preco = converterPrecoParaNumero(elements.servicePrice.value);

    elements.servicePrice.value =
      preco > 0 ? formatarPrecoParaCampo(preco) : "";
    atualizarPreviaSinalPix();
  });

  elements.servicePrice?.addEventListener("input", atualizarPreviaSinalPix);
  elements.pixSignalType?.addEventListener("change", atualizarCamposSinalPix);
  elements.pixSignalValue?.addEventListener("input", atualizarPreviaSinalPix);

  document.querySelectorAll("[data-close-service-modal]").forEach((button) => {
    button.addEventListener("click", fecharModalServico);
  });

  document.querySelectorAll("[data-close-delete-modal]").forEach((button) => {
    button.addEventListener("click", fecharModalExcluir);
  });

  elements.confirmDeleteButton?.addEventListener("click", excluirServico);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    if (!elements.deleteModal.hidden) {
      fecharModalExcluir();
      return;
    }

    if (!elements.serviceModal.hidden) {
      fecharModalServico();
      return;
    }

    if (!elements.categoriesModal.hidden) {
      fecharModalCategorias();
    }
  });
}

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */

function iniciarPagina() {
  carregarElementos();
  configurarEventos();

  elements.newServiceButton.disabled = true;

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
          "Esta conta não possui permissão para gerenciar os serviços.",
        );

        return;
      }

      liberarConteudo();

      await carregarServicos();
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


