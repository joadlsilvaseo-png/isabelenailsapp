import { setupPushNotifications } from "./notificationService.js";
import { auth, db } from "./firebase-config.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const fallbackName = "Cliente";

const fallbackAvatar = "https://www.w3schools.com/howto/img_avatar2.png";

/*
 * Palavras relacionadas a cada categoria.
 * Isso permite pesquisar tanto pela categoria quanto
 * pelos procedimentos encontrados dentro dela.
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

function setupPrincipalSearch() {
  const searchForm = document.getElementById("principal-search-form");

  const searchInput = document.getElementById("principal-search-input");

  const searchFeedback = document.getElementById("principal-search-feedback");

  const servicesSection = document.querySelector(".principal-services");

  const serviceItems = Array.from(
    document.querySelectorAll("#principal-services-list > li"),
  );

  if (!searchForm || !searchInput || serviceItems.length === 0) {
    return;
  }

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

  function updateSearchFeedback() {
    return;
  }

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

    updateSearchFeedback(query, visibleItems);

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

function initPrincipalPage() {
  const nameElement = document.getElementById("nome-cliente");

  const photoElement = document.getElementById("foto-perfil");

  setupPrincipalSearch();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }

    /*
     * Impede administradores de acessarem
     * a visualização destinada aos clientes.
     */
    try {
      const userRef = doc(db, "clientes", user.uid);

      const userSnap = await getDoc(userRef);

      if (userSnap.exists() && userSnap.data().role === "admin") {
        window.location.href = "dashboard.html";
        return;
      }
    } catch (error) {
      console.error("Erro ao verificar restrição de admin:", error);
    }

    if (nameElement) {
      nameElement.textContent = user.displayName || fallbackName;
    }

    if (photoElement) {
      photoElement.src = user.photoURL || fallbackAvatar;
    }

    setupPushNotifications(user.uid);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPrincipalPage);
} else {
  initPrincipalPage();
}
