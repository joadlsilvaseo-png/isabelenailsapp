import { setupPushNotifications } from "./notificationService.js";
import { auth, db } from "./firebase-config.js";

import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const fallbackClientName = "Cliente";
const fallbackAdminName = "Isabele";
const fallbackAvatar = "https://www.w3schools.com/howto/img_avatar2.png";
let principalSearchInitialized = false;

/*
 * Palavras relacionadas a cada categoria.
 * Permite pesquisar pela categoria ou pelos
 * procedimentos encontrados dentro dela.
 */
const categorySearchTerms = {
  "unhas-em-gel.html": [
    "Unhas em Gel",
    "Fibra de Vidro",
    "Alongamento",
    "Alongamento em Gel",
    "Banho de Gel",
    "Blindagem",
    "Manutenção",
    "Remoção",
  ],

  "manicure.html": [
    "Manicure",
    "Manicure Simples",
    "Manicure Completa",
    "Mãos",
    "Esmaltação",
    "Esmaltação em Gel",
    "Cutilagem",
    "Francesinha",
    "Decoração",
    "Spa das Mãos",
  ],

  "pedicure.html": [
    "Pedicure",
    "Pedicure Simples",
    "Pedicure em Gel",
    "Pedicure e Manicure",
    "Pés",
    "Spa dos Pés",
    "Hidratação",
    "Cutilagem dos Pés",
    "Esmaltação dos Pés",
    "Francesinha dos Pés",
  ],
};

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/* ============================================================
   PESQUISA DA ÁREA DA CLIENTE
   ============================================================ */

function setupPrincipalSearch() {
  if (principalSearchInitialized) {
    return;
  }

  const searchForm = document.getElementById("principal-search-form");

  const searchInput = document.getElementById("principal-search-input");

  const servicesSection = document.querySelector(".principal-services");

  const serviceItems = Array.from(
    document.querySelectorAll("#principal-services-list > li"),
  );

  if (!searchForm || !searchInput || serviceItems.length === 0) {
    return;
  }

  principalSearchInitialized = true;

  const searchableItems = serviceItems.map((item) => {
    const serviceLink = item.querySelector(".service-row");

    const serviceContent = item.querySelector(".service-content");

    const serviceLabel =
      item.querySelector(".service-label")?.textContent?.trim() || "";

    const serviceDescription =
      item.querySelector(".service-description")?.textContent?.trim() || "";

    const serviceHref = serviceLink?.getAttribute("href") || "";

    const terms = categorySearchTerms[serviceHref] || [];

    let matchElement = item.querySelector(".service-match");

    if (!matchElement && serviceContent) {
      matchElement = document.createElement("span");

      matchElement.className = "service-match";
      matchElement.hidden = true;

      serviceContent.appendChild(matchElement);
    }

    const normalizedTerms = terms.map((term) => ({
      label: term,
      value: normalizeSearchText(term),
    }));

    const searchText = normalizeSearchText(`
      ${serviceLabel}
      ${serviceDescription}
      ${terms.join(" ")}
    `);

    return {
      item,
      serviceLink,
      serviceLabel,
      matchElement,
      normalizedTerms,
      searchText,
    };
  });

  function filterServices(query) {
    const normalizedQuery = normalizeSearchText(query);

    const visibleItems = [];

    searchableItems.forEach((searchableItem) => {
      const matchesSearch =
        !normalizedQuery || searchableItem.searchText.includes(normalizedQuery);

      searchableItem.item.hidden = !matchesSearch;

      let matchedTerm = null;

      if (normalizedQuery && matchesSearch) {
        matchedTerm =
          searchableItem.normalizedTerms.find((term) =>
            term.value.includes(normalizedQuery),
          ) || null;
      }

      if (searchableItem.matchElement) {
        const categoryName = normalizeSearchText(searchableItem.serviceLabel);

        const shouldShowTerm =
          Boolean(matchedTerm) && matchedTerm.value !== categoryName;

        searchableItem.matchElement.hidden = !shouldShowTerm;

        searchableItem.matchElement.textContent = shouldShowTerm
          ? `Encontrado: ${matchedTerm.label}`
          : "";
      }

      if (matchesSearch) {
        visibleItems.push(searchableItem);
      }
    });

    return visibleItems;
  }

  function clearSearch() {
    searchInput.value = "";
    filterServices("");
    searchInput.focus();
  }

  searchInput.addEventListener("input", () => {
    filterServices(searchInput.value);
  });

  searchInput.addEventListener("search", () => {
    filterServices(searchInput.value);
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    event.preventDefault();
    clearSearch();
  });

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const currentQuery = searchInput.value.trim();

    const visibleItems = filterServices(currentQuery);

    if (!currentQuery) {
      searchInput.focus();
      return;
    }

    if (visibleItems.length === 1) {
      const destination = visibleItems[0].serviceLink?.getAttribute("href");

      if (destination) {
        window.location.href = destination;
      }

      return;
    }

    servicesSection?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  });
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

  const clienteData = clienteSnapshot.exists() ? clienteSnapshot.data() : null;

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
   AUTENTICAÇÃO E PERMISSÃO
   ============================================================ */

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

    /*
     * Mantém o token de notificação associado
     * ao UID autenticado.
     */
    setupPushNotifications(user.uid).catch((error) => {
      console.warn("Não foi possível configurar as notificações:", error);
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
