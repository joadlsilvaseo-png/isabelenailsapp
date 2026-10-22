import {
  setupPushNotifications,
  ativarNotificacoes,
} from "./notificationService.js";
import { auth, db } from "./firebase-config.js";
import { iniciarCentralNotificacoes } from "./centralNotificacoesUI.js";
import { consultarFotoPerfil } from "./foto-perfil-api.js";
import { montarPerfilClienteAuth, podeRecuperarPerfilCliente } from "./clientePerfilIntegridade.js";

import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

import { montarCatalogoCliente, normalizarSlugCategoria } from "./categoriasCatalogo.mjs";
import { montarResultadosBusca } from "./catalogoBusca.mjs";

const fallbackClientName = "Cliente";
const fallbackAdminName = "Isabele";
const fallbackAvatar = "https://www.w3schools.com/howto/img_avatar2.png";
let principalSearchInitialized = false;
let catalogoServicosCliente = [];
let catalogoCategoriasCliente = [];

const paginasLegadasCategoria = {
  "unhas-em-gel": "unhas-em-gel.html",
  manicure: "manicure.html",
  pedicure: "pedicure.html",
};

function escaparTextoBusca(texto) {
  return String(texto || "").trim();
}

async function carregarCatalogoCliente() {
  const lista = document.getElementById("principal-services-list");
  if (!lista) return;
  try {
    const [categoriasSnapshot, servicosSnapshot] = await Promise.all([
      getDocs(collection(db, "categorias")),
      getDocs(collection(db, "servicos")),
    ]);
    const categorias = categoriasSnapshot.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
    const servicos = servicosSnapshot.docs.map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
    const slugsLegados = ["unhas-em-gel", "manicure", "pedicure"];
    for (const slug of slugsLegados) {
      const corresponde = categorias.some((categoria) => normalizarSlugCategoria(categoria.slug || categoria.nome) === slug || (categoria.legacySlugs || []).map(normalizarSlugCategoria).includes(slug));
      if (!corresponde) categorias.push({ id: `legacy_${slug}`, slug, nome: slug === "unhas-em-gel" ? "Unhas em Gel" : slug.charAt(0).toUpperCase() + slug.slice(1), ativo: true, legacySlugs: [slug] });
    }
    const catalogo = montarCatalogoCliente(categorias, servicos);
    catalogoCategoriasCliente = catalogo;
    catalogoServicosCliente = catalogo.flatMap((categoria) => categoria.servicos.map((servico) => ({
      ...servico,
      categoriaNome: categoria.nome,
      categoriaDescricao: categoria.descricao || "",
      palavrasChave: Array.isArray(servico.palavrasChave) ? servico.palavrasChave : [],
    })));

    const itensFixos = Array.from(lista.querySelectorAll(":scope > li"));
    const slugsMostrados = new Set();
    itensFixos.forEach((item) => {
      const link = item.querySelector(".service-row");
      const slug = normalizarSlugCategoria((link?.getAttribute("href") || "").replace(/\.html.*$/, ""));
      const categoria = catalogo.find((itemCategoria) => normalizarSlugCategoria(itemCategoria.slug || itemCategoria.nome) === slug);
      item.hidden = !categoria;
      if (categoria) slugsMostrados.add(slug);
    });

    lista.querySelectorAll("li[data-dynamic-category]").forEach((item) => item.remove());
    catalogo.forEach((categoria) => {
      const slug = normalizarSlugCategoria(categoria.slug || categoria.nome);
      if (slugsMostrados.has(slug) || paginasLegadasCategoria[slug]) return;
      const li = document.createElement("li");
      li.dataset.dynamicCategory = categoria.id;
      const link = document.createElement("a");
      link.className = "service-row";
      link.href = `categoria.html?categoriaId=${encodeURIComponent(categoria.id)}`;
      const icon = document.createElement("span"); icon.className = "service-icon"; icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3L13.2 6.2L16.5 7.5L13.2 8.8L12 12L10.8 8.8L7.5 7.5L10.8 6.2L12 3Z" stroke="currentColor" stroke-width="1.8"/></svg>';
      const content = document.createElement("span"); content.className = "service-content";
      const name = document.createElement("strong"); name.className = "service-label"; name.textContent = categoria.nome;
      const detail = document.createElement("span"); detail.className = "service-description"; detail.textContent = categoria.descricao || `${categoria.servicos.length} ${categoria.servicos.length === 1 ? "serviço disponível" : "serviços disponíveis"}`;
      content.append(name, detail);
      const chevron = document.createElement("span"); chevron.className = "service-chevron"; chevron.setAttribute("aria-hidden", "true"); chevron.textContent = "›";
      link.append(icon, content, chevron); li.append(link); lista.append(li);
    });
  } catch (error) {
    console.error("Não foi possível carregar as categorias e serviços:", error);
  }
}

function setupPrincipalSearch() {
  if (principalSearchInitialized) return;
  const searchForm = document.getElementById("principal-search-form");
  const searchInput = document.getElementById("principal-search-input");
  const list = document.getElementById("principal-services-list");
  const resultList = document.getElementById("principal-search-results");
  const servicesSection = document.querySelector(".principal-services");
  if (!searchForm || !searchInput || !list || !resultList) return;
  principalSearchInitialized = true;

  function renderResults(queryText) {
    const query = escaparTextoBusca(queryText);
    if (!query) {
      resultList.hidden = true;
      resultList.replaceChildren();
      list.hidden = false;
      return [];
    }
    const results = montarResultadosBusca(catalogoServicosCliente, query);
    resultList.replaceChildren();
    list.hidden = true;
    resultList.hidden = false;
    if (!results.length) {
      const empty = document.createElement("li");
      empty.className = "principal-search-empty";
      empty.textContent = "Nenhum serviço encontrado. Tente outro termo.";
      resultList.append(empty);
      return results;
    }
    results.forEach((service) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.className = "service-row";
      link.href = `agendamento.html?id=${encodeURIComponent(service.id)}`;
      const icon = document.createElement("span"); icon.className = "service-icon"; icon.setAttribute("aria-hidden", "true"); icon.textContent = "⌕";
      const content = document.createElement("span"); content.className = "service-content";
      const name = document.createElement("strong"); name.className = "service-label"; name.textContent = service.nome || "Serviço";
      const desc = document.createElement("span"); desc.className = "service-description"; desc.textContent = service.categoriaNome || "Categoria";
      content.append(name, desc); link.append(icon, content); item.append(link); resultList.append(item);
    });
    return results;
  }

  searchInput.addEventListener("input", () => renderResults(searchInput.value));
  searchInput.addEventListener("search", () => renderResults(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    searchInput.value = ""; renderResults(""); searchInput.focus();
  });
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const results = renderResults(searchInput.value);
    if (results.length === 1) window.location.href = `agendamento.html?id=${encodeURIComponent(results[0].id)}`;
    else servicesSection?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  void carregarCatalogoCliente();
}

/* ============================================================
   ELEMENTOS DA PÁGINA
   ============================================================ */

function getPrincipalElements() {
  return {
    body: document.body,

    loadingSection: document.getElementById("principal-access-loading"),

    pageTitle: document.getElementById("principal-page-title"),

    greeting: document.getElementById("principal-greeting"),

    name: document.getElementById("nome-cliente"),

    description: document.getElementById("principal-profile-description"),

    photo: document.getElementById("foto-perfil"),

    roleBadge: document.getElementById("principal-role-badge"),

    profileLink: document.getElementById("principal-profile-link"),

    navPlaceholder: document.getElementById("principal-nav-placeholder"),
  };
}

function hideAllRoleSections() {
  document.querySelectorAll("[data-role-section]").forEach((section) => {
    section.hidden = true;
  });
}

function showRoleSections(role) {
  hideAllRoleSections();

  document
    .querySelectorAll(`[data-role-section="${role}"]`)
    .forEach((section) => {
      section.hidden = false;
    });
}

function finishLoading(elements) {
  if (elements.loadingSection) {
    elements.loadingSection.hidden = true;
  }
}

function showAccessError(elements, title, message) {
  hideAllRoleSections();

  if (!elements.loadingSection) {
    window.alert(message);
    return;
  }

  elements.loadingSection.hidden = false;
  elements.loadingSection.classList.add("principal-access-loading--error");

  const spinner = elements.loadingSection.querySelector(
    ".principal-loading-spinner",
  );

  const titleElement = elements.loadingSection.querySelector("strong");

  const messageElement = elements.loadingSection.querySelector("p");

  if (spinner) {
    spinner.hidden = true;
  }

  if (titleElement) {
    titleElement.textContent = title;
  }

  if (messageElement) {
    messageElement.textContent = message;
  }
}

/* ============================================================
   LEITURA DO PERFIL
   ============================================================ */

async function loadUserAccessProfile(user) {
  const usuarioRef = doc(db, "usuarios", user.uid);

  const clienteRef = doc(db, "clientes", user.uid);

  const [usuarioSnapshot, clienteSnapshot] = await Promise.all([
    getDoc(usuarioRef),
    getDoc(clienteRef),
  ]);

  const usuarioData = usuarioSnapshot.exists() ? usuarioSnapshot.data() : null;

  let clienteData = clienteSnapshot.exists() ? clienteSnapshot.data() : null;

  // Conta existente no Authentication sem perfil em clientes/{uid}.
  // A transacao cria somente quando ausente e nunca altera perfis anteriores.
  if (podeRecuperarPerfilCliente(usuarioData, clienteData)) {
    const perfilRecuperado = montarPerfilClienteAuth(user, {
      nomeAlternativo: usuarioData?.nome,
      telefoneAlternativo: usuarioData?.telefone,
    });
    await runTransaction(db, async (transaction) => {
      const atual = await transaction.get(clienteRef);
      if (!atual.exists()) transaction.set(clienteRef, perfilRecuperado);
    });
    const clienteRestaurado = await getDoc(clienteRef);
    if (!clienteRestaurado.exists()) {
      throw new Error("Cadastro da cliente não foi persistido no Firestore.");
    }
    clienteData = clienteRestaurado.data();
  }

  /*
   * A coleção usuarios é a fonte principal
   * para permissão administrativa.
   */
  if (usuarioData) {
    const role = String(usuarioData.role || "")
      .trim()
      .toLowerCase();

    if (usuarioData.ativo !== true) {
      return {
        allowed: false,
        reason: "inactive",
        role,
        usuarioData,
        clienteData,
      };
    }

    if (role !== "admin" && role !== "cliente") {
      return {
        allowed: false,
        reason: "invalid-role",
        role,
        usuarioData,
        clienteData,
      };
    }

    return {
      allowed: true,
      role,
      usuarioData,
      clienteData,
    };
  }

  /*
   * Compatibilidade temporária:
   * clientes cadastradas antes da criação
   * da coleção usuarios continuam acessando.
   *
   * A ausência em usuarios nunca concede
   * acesso administrativo.
   */
  if (clienteData) {
    return {
      allowed: true,
      role: "cliente",
      usuarioData: null,
      clienteData,
    };
  }

  /*
   * Conta autenticada sem perfil no Firestore.
   * Mantemos como cliente para não bloquear
   * o fluxo atual de login.
   */
  return {
    allowed: true,
    role: "cliente",
    usuarioData: null,
    clienteData: null,
  };
}

/* ============================================================
   INTERFACE DA CLIENTE
   ============================================================ */

function configureClientInterface(user, accessProfile, elements) {
  const userData = accessProfile.usuarioData || {};

  const clientData = accessProfile.clienteData || {};

  const clientName =
    clientData.nome || userData.nome || user.displayName || fallbackClientName;

  const clientPhoto =
    clientData.foto || userData.foto || user.photoURL || fallbackAvatar;

  elements.body.dataset.userRole = "cliente";

  if (elements.pageTitle) {
    elements.pageTitle.textContent = "Principal";
  }

  if (elements.greeting) {
    elements.greeting.textContent = "Seja bem-vinda";
  }

  if (elements.name) {
    elements.name.textContent = clientName;
  }

  if (elements.description) {
    elements.description.textContent =
      "Escolha seu próximo cuidado e acompanhe seus agendamentos.";
  }

  if (elements.photo) {
    elements.photo.src = clientPhoto;
    elements.photo.alt = `Foto de perfil de ${clientName}`;
  }

  if (elements.roleBadge) {
    elements.roleBadge.textContent = "Cliente";

    elements.roleBadge.hidden = false;
  }

  if (elements.profileLink) {
    elements.profileLink.href = "meu-perfil.html";

    elements.profileLink.setAttribute("aria-label", "Meu perfil");

    elements.profileLink.hidden = false;
  }

  if (elements.navPlaceholder) {
    elements.navPlaceholder.hidden = true;
  }

  showRoleSections("cliente");
  setupPrincipalSearch();
  finishLoading(elements);
}

/* ============================================================
   INTERFACE ADMINISTRATIVA
   ============================================================ */

function configureAdminInterface(user, accessProfile, elements) {
  const userData = accessProfile.usuarioData || {};

  const clientData = accessProfile.clienteData || {};

  const adminName =
    userData.nome || clientData.nome || user.displayName || fallbackAdminName;

  const adminPhoto =
    userData.foto || clientData.foto || user.photoURL || fallbackAvatar;

  elements.body.dataset.userRole = "admin";

  if (elements.pageTitle) {
    elements.pageTitle.textContent = "Gestão";
  }

  if (elements.greeting) {
    elements.greeting.textContent = "Bem-vinda à sua gestão";
  }

  if (elements.name) {
    elements.name.textContent = adminName;
  }

  if (elements.description) {
    elements.description.textContent =
      "Gerencie seus atendimentos, serviços e resultados.";
  }

  if (elements.photo) {
    elements.photo.src = adminPhoto;
    elements.photo.alt = `Foto de perfil de ${adminName}`;
  }

  if (elements.roleBadge) {
    elements.roleBadge.textContent = "Administradora";

    elements.roleBadge.hidden = false;
  }

  /*
   * Ainda não existe uma página exclusiva
   * de perfil administrativo.
   */
  if (elements.profileLink) {
    elements.profileLink.hidden = true;
  }

  if (elements.navPlaceholder) {
    elements.navPlaceholder.hidden = false;
  }

  showRoleSections("admin");
  finishLoading(elements);
}
/* ============================================================
   LOGOUT ADMINISTRATIVO
   ============================================================ */

function setupPrincipalLogout(elements) {
  const logoutButton = elements.navPlaceholder;

  if (!logoutButton) {
    return;
  }

  logoutButton.addEventListener("click", async () => {
    const confirmou = window.confirm("Deseja sair da sua conta?");

    if (!confirmou) {
      return;
    }

    logoutButton.disabled = true;

    try {
      await signOut(auth);

      window.location.replace("login.html");
    } catch (error) {
      console.error("Erro ao sair da conta:", error);

      window.alert("Não foi possível sair da conta. Tente novamente.");

      logoutButton.disabled = false;
    }
  });
}
/* ============================================================
   NAVEGAÇÃO INFERIOR DA CLIENTE
   ============================================================ */

function setupPrincipalNavigation() {
  const homeNavigation = document.querySelector('[data-navigation="home"]');

  const servicesNavigation = document.querySelector(
    '[data-navigation="services"]',
  );

  if (!homeNavigation || !servicesNavigation) {
    return;
  }

  function updatePrincipalNavigationState() {
    const servicesActive = window.location.hash === "#services-title";

    homeNavigation.classList.toggle(
      "client-navigation-item--active",
      !servicesActive,
    );

    servicesNavigation.classList.toggle(
      "client-navigation-item--active",
      servicesActive,
    );

    if (!servicesActive) {
      homeNavigation.setAttribute("aria-current", "page");
    } else {
      homeNavigation.removeAttribute("aria-current");
    }

    if (servicesActive) {
      servicesNavigation.setAttribute("aria-current", "page");
    } else {
      servicesNavigation.removeAttribute("aria-current");
    }
  }

  window.addEventListener("hashchange", updatePrincipalNavigationState);

  updatePrincipalNavigationState();
}
/* ============================================================
   ATIVAÇÃO DAS NOTIFICAÇÕES WEB PUSH
   ============================================================ */

async function configurarNotificacoesPrincipal(user) {
  const painel = document.getElementById("principal-push-card");
  const botao = document.getElementById("principal-push-button");
  const descricao = document.getElementById("principal-push-description");
  const status = document.getElementById("principal-push-status");

  if (!painel || !botao || !descricao || !status) {
    return;
  }

  const suportado =
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    window.isSecureContext;

  if (!suportado) {
    painel.hidden = true;
    return;
  }

  painel.hidden = false;
  botao.hidden = false;
  status.textContent = "";

  if (Notification.permission === "denied") {
    descricao.textContent =
      "As notificações estão bloqueadas nas configurações do navegador.";

    botao.hidden = true;
    return;
  }

  const autorizado = Notification.permission === "granted";

  descricao.textContent = autorizado
    ? "Estamos verificando a conexão deste dispositivo."
    : "Receba avisos sobre seus agendamentos e atualizações.";

  botao.textContent = autorizado ? "Verificando..." : "Ativar notificações";

  botao.disabled = autorizado;

  // O pedido de permissão acontece somente após o clique.
  botao.onclick = async () => {
    botao.disabled = true;
    botao.textContent = "Ativando...";
    status.textContent = "";

    let inscricao = null;

    try {
      inscricao = await ativarNotificacoes(user.uid);
    } catch (erro) {
      console.warn("Falha ao ativar notificações:", erro);
    }

    if (inscricao) {
      painel.hidden = true;
      return;
    }

    if (Notification.permission === "denied") {
      descricao.textContent =
        "Autorize as notificações nas configurações do navegador.";

      botao.hidden = true;
      return;
    }

    botao.disabled = false;
    botao.textContent = "Tentar novamente";

    status.textContent =
      Notification.permission === "granted"
        ? "Permissão concedida, mas não foi possível conectar ao servidor."
        : "Não foi possível ativar as notificações. Tente novamente.";
  };

  // Reaproveita a permissão de quem já autorizou notificações.
  if (autorizado) {
    let inscricao = null;

    try {
      inscricao = await setupPushNotifications(user.uid);
    } catch (erro) {
      console.warn("Falha ao restaurar notificações:", erro);
    }

    if (inscricao) {
      painel.hidden = true;
      return;
    }

    botao.disabled = false;
    botao.textContent = "Tentar novamente";

    descricao.textContent =
      "Permissão concedida. Falta conectar este dispositivo.";

    status.textContent =
      "Não foi possível conectar ao servidor de notificações.";
  }
}

/* ============================================================
   AUTENTICAÇÃO E PERMISSÃO
   ============================================================ */

/* FOTO PERSONALIZADA — POSTGRESQL */

let fotoPersonalizadaUrl = null;

async function carregarFotoPersonalizada(user, elementoFoto) {
  if (!elementoFoto) return;

  const fotoAnterior = elementoFoto.src;

  try {
    const arquivo = await consultarFotoPerfil();

    // Não existe personalização: mantém a foto do Google.
    if (!arquivo) return;

    // Evita substituir uma foto alterada durante a consulta.
    if (
      auth.currentUser?.uid !== user.uid ||
      elementoFoto.src !== fotoAnterior
    ) {
      return;
    }

    const novaUrl = URL.createObjectURL(arquivo);
    const urlAntiga = fotoPersonalizadaUrl;

    fotoPersonalizadaUrl = novaUrl;
    elementoFoto.src = novaUrl;

    const botaoRemover = document.getElementById("remover-foto-perfil");

    if (botaoRemover) {
      botaoRemover.hidden = false;
    }

    if (urlAntiga) {
      URL.revokeObjectURL(urlAntiga);
    }
  } catch (erro) {
    console.warn(
      "Foto personalizada indisponível. Mantendo foto atual:",
      erro.message,
    );
  }
}

window.addEventListener("pagehide", () => {
  if (fotoPersonalizadaUrl) {
    URL.revokeObjectURL(fotoPersonalizadaUrl);
    fotoPersonalizadaUrl = null;
  }
});

async function handleAuthenticatedUser(user, elements) {
  try {
    const accessProfile = await loadUserAccessProfile(user);

    if (!accessProfile.allowed) {
      if (accessProfile.reason === "inactive") {
        showAccessError(
          elements,
          "Acesso desativado",
          "Esta conta está desativada. Entre em contato com a responsável pelo aplicativo.",
        );
      } else {
        showAccessError(
          elements,
          "Perfil inválido",
          "Não foi possível identificar uma permissão válida para esta conta.",
        );
      }

      await signOut(auth);
      return;
    }

    if (accessProfile.role === "admin") {
      configureAdminInterface(user, accessProfile, elements);
    } else {
      configureClientInterface(user, accessProfile, elements);
    }
    // Carrega a foto personalizada sem bloquear a tela.
    void carregarFotoPersonalizada(user, elements.photo);
    // Central de notificações para cliente e administradora.
    iniciarCentralNotificacoes(user);

    /*
     * Configura as notificações após identificar
     * o perfil autenticado, sem bloquear a página.
     */
    configurarNotificacoesPrincipal(user).catch((error) => {
      console.warn("Não foi possível preparar as notificações:", error);
    });
  } catch (error) {
    console.error("Erro ao carregar o perfil da Principal:", error);

    showAccessError(
      elements,
      "Não foi possível carregar",
      "Verifique sua conexão e tente abrir o aplicativo novamente.",
    );
  }
}

function initPrincipalPage() {
  const elements = getPrincipalElements();

  setupPrincipalLogout(elements);
  setupPrincipalNavigation();
  hideAllRoleSections();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");

      return;
    }

    await handleAuthenticatedUser(user, elements);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPrincipalPage);
} else {
  initPrincipalPage();
}

