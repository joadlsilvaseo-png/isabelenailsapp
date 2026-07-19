import { db } from "./firebase-config.js";

import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const categoryName = "Manicure";

const serviceList = document.getElementById("lista-servicos");

const serviceCount = document.getElementById("manicure-service-count");

const nextButton = document.querySelector(".manicure-button");

const selectionSummary = document.getElementById("selected-service-summary");

let selectedServiceId = null;
let selectedServiceName = "";

const defaultDescriptions = {
  "manicure simples":
    "Cuidado completo das unhas das mãos, incluindo preparação, cutilagem e esmaltação com acabamento delicado.",

  manicure:
    "Cuidado completo das unhas das mãos, com preparação, cutilagem e acabamento profissional.",

  esmaltacao:
    "Preparação das unhas e aplicação do esmalte escolhido, proporcionando cor uniforme e acabamento cuidadoso.",

  "esmaltacao em gel":
    "Esmaltação realizada com produto em gel e secagem em cabine, oferecendo brilho intenso e maior durabilidade.",

  "manicure completa":
    "Procedimento completo com preparação, cutilagem, lixamento, hidratação e esmaltação das unhas.",

  cutilagem:
    "Remoção cuidadosa do excesso de cutículas para proporcionar unhas mais limpas e bem cuidadas.",

  francesinha:
    "Acabamento clássico e delicado, com destaque nas pontas das unhas para um visual elegante.",

  decoracao:
    "Personalização das unhas com desenhos, detalhes ou aplicações escolhidas de acordo com o estilo desejado.",

  "spa das maos":
    "Experiência de cuidado com esfoliação, hidratação e massagem para deixar as mãos macias e revitalizadas.",

  "remocao de esmalte em gel":
    "Remoção técnica do esmalte em gel, realizada com cuidado para preservar a integridade das unhas naturais.",
};

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getServiceDescription(service) {
  if (typeof service.descricao === "string" && service.descricao.trim()) {
    return service.descricao.trim();
  }

  const normalizedName = normalizeText(service.nome);

  return (
    defaultDescriptions[normalizedName] ||
    "Procedimento realizado com cuidado profissional para proporcionar unhas bonitas, bem cuidadas e com acabamento delicado."
  );
}

function formatPrice(value) {
  if (value === undefined || value === null || value === "") {
    return "Valor a consultar";
  }

  const rawValue = String(value).trim().replace(/R\$/gi, "").replace(/\s/g, "");

  const normalizedValue = rawValue.includes(",")
    ? rawValue.replace(/\./g, "").replace(",", ".")
    : rawValue;

  const numericValue = Number(normalizedValue);

  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(numericValue);
}

function formatDuration(value) {
  if (value === undefined || value === null || value === "") {
    return "Duração a confirmar";
  }

  if (typeof value === "string" && /hora|min/i.test(value)) {
    return value;
  }

  const totalMinutes = Number(value);

  if (!Number.isFinite(totalMinutes)) {
    return String(value);
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}min`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  return `${minutes}min`;
}

function getServiceIcon(serviceName) {
  const normalizedName = normalizeText(serviceName);

  if (normalizedName.includes("spa")) {
    return `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M12 21C7 18.5 4 15.3 4 11.5C4 8.8 6 7 8.5 7C10 7 11.2 7.7 12 8.8C12.8 7.7 14 7 15.5 7C18 7 20 8.8 20 11.5C20 15.3 17 18.5 12 21Z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <path
          d="M8 3L8.6 4.4L10 5L8.6 5.6L8 7L7.4 5.6L6 5L7.4 4.4L8 3Z"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  if (
    normalizedName.includes("decoracao") ||
    normalizedName.includes("francesinha")
  ) {
    return `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3L13.2 6.2L16.5 7.5L13.2 8.8L12 12L10.8 8.8L7.5 7.5L10.8 6.2L12 3Z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <path
          d="M18 13L18.8 15.2L21 16L18.8 16.8L18 19L17.2 16.8L15 16L17.2 15.2L18 13Z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <path
          d="M6 13L6.7 14.8L8.5 15.5L6.7 16.2L6 18L5.3 16.2L3.5 15.5L5.3 14.8L6 13Z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    `;
  }

  if (normalizedName.includes("remocao")) {
    return `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M7 17L17 7"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />

        <path
          d="M7 7L17 17"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />

        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          stroke-width="1.8"
        />
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M9 9H15C16.1 9 17 9.9 17 11V19C17 20.1 16.1 21 15 21H9C7.9 21 7 20.1 7 19V11C7 9.9 7.9 9 9 9Z"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
      />

      <path
        d="M10 9V5H14V9"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <path
        d="M9 5H15"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />

      <path
        d="M10 13H14"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      />
    </svg>
  `;
}

function clearSelection() {
  if (!serviceList) return;

  const cards = serviceList.querySelectorAll(".manicure-card");

  cards.forEach((card) => {
    card.classList.remove("selected");
    card.setAttribute("aria-pressed", "false");
  });
}

function selectServiceCard(card) {
  clearSelection();

  card.classList.add("selected");
  card.setAttribute("aria-pressed", "true");

  selectedServiceId = card.dataset.serviceId || null;

  selectedServiceName = card.dataset.serviceName || "Serviço selecionado";

  if (nextButton) {
    nextButton.disabled = false;
  }

  if (selectionSummary) {
    selectionSummary.textContent = `${selectedServiceName} selecionado`;
  }
}

function setupCardBehavior(card) {
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-pressed", "false");

  card.addEventListener("click", () => {
    selectServiceCard(card);
  });

  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    selectServiceCard(card);
  });
}

function createServiceCard(service) {
  const serviceName = service.nome || "Serviço";

  const listItem = document.createElement("li");

  listItem.className = "manicure-card";

  listItem.dataset.serviceId = service.id;
  listItem.dataset.serviceName = serviceName;

  listItem.setAttribute("aria-label", `Selecionar ${serviceName}`);

  const cardTop = document.createElement("div");

  cardTop.className = "manicure-card-top";

  const icon = document.createElement("span");

  icon.className = "manicure-card-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = getServiceIcon(serviceName);

  const cardContent = document.createElement("div");

  cardContent.className = "manicure-card-content";

  const cardName = document.createElement("p");

  cardName.className = "manicure-card-name";
  cardName.textContent = serviceName;

  const cardDescription = document.createElement("p");

  cardDescription.className = "manicure-card-description";

  cardDescription.textContent = getServiceDescription(service);

  const check = document.createElement("span");

  check.className = "manicure-card-check";
  check.setAttribute("aria-hidden", "true");

  check.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M6 12.5L10 16.5L18 8.5"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;

  cardContent.appendChild(cardName);
  cardContent.appendChild(cardDescription);

  cardTop.appendChild(icon);
  cardTop.appendChild(cardContent);
  cardTop.appendChild(check);

  const cardDetails = document.createElement("div");

  cardDetails.className = "manicure-card-details";

  const cardDuration = document.createElement("span");

  cardDuration.className = "manicure-card-duration";

  cardDuration.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="1.8"
      />

      <path
        d="M12 7V12L15 14"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;

  const durationText = document.createElement("span");

  durationText.textContent = formatDuration(service.duracao);

  cardDuration.appendChild(durationText);

  const cardPrice = document.createElement("strong");

  cardPrice.className = "manicure-card-price";

  cardPrice.textContent = formatPrice(service.preco);

  cardDetails.appendChild(cardDuration);
  cardDetails.appendChild(cardPrice);

  listItem.appendChild(cardTop);
  listItem.appendChild(cardDetails);

  setupCardBehavior(listItem);

  return listItem;
}

function renderState(title, message) {
  if (!serviceList) return;

  serviceList.innerHTML = "";

  const stateCard = document.createElement("li");

  stateCard.className = "manicure-state-card";

  const stateTitle = document.createElement("strong");

  stateTitle.textContent = title;

  const stateMessage = document.createElement("span");

  stateMessage.textContent = message;

  stateCard.appendChild(stateTitle);
  stateCard.appendChild(stateMessage);

  serviceList.appendChild(stateCard);
}

function renderServices(services) {
  if (!serviceList) return;

  serviceList.innerHTML = "";
  serviceList.classList.remove("loading");
  serviceList.setAttribute("aria-busy", "false");

  if (!services.length) {
    renderState(
      "Nenhum procedimento disponível",
      "Novos serviços poderão ser adicionados em breve.",
    );

    if (serviceCount) {
      serviceCount.textContent = "0 serviços";
    }

    return;
  }

  const fragment = document.createDocumentFragment();

  services.forEach((service) => {
    fragment.appendChild(createServiceCard(service));
  });

  serviceList.appendChild(fragment);

  if (serviceCount) {
    serviceCount.textContent =
      services.length === 1 ? "1 serviço" : `${services.length} serviços`;
  }
}

async function loadManicureServices() {
  if (!serviceList) return;

  const servicesRef = collection(db, "servicos");

  const servicesQuery = query(
    servicesRef,
    where("categoria", "==", categoryName),
  );

  try {
    const querySnapshot = await getDocs(servicesQuery);

    const services = querySnapshot.docs
      .map((serviceDocument) => ({
        id: serviceDocument.id,
        ...serviceDocument.data(),
      }))
      .filter((service) => service.ativo !== false)
      .sort((serviceA, serviceB) => {
        const orderA = Number.isFinite(Number(serviceA.ordem))
          ? Number(serviceA.ordem)
          : 999;

        const orderB = Number.isFinite(Number(serviceB.ordem))
          ? Number(serviceB.ordem)
          : 999;

        if (orderA !== orderB) {
          return orderA - orderB;
        }

        return String(serviceA.nome || "").localeCompare(
          String(serviceB.nome || ""),
          "pt-BR",
        );
      });

    renderServices(services);
  } catch (error) {
    console.error("Erro ao carregar serviços de manicure:", error);

    serviceList.classList.remove("loading");
    serviceList.setAttribute("aria-busy", "false");

    renderState(
      "Não foi possível carregar os serviços",
      "Verifique sua conexão e tente novamente em alguns instantes.",
    );

    if (serviceCount) {
      serviceCount.textContent = "Indisponível";
    }
  }
}

function setupNextButton() {
  if (!nextButton) return;

  nextButton.disabled = true;

  nextButton.addEventListener("click", () => {
    if (!selectedServiceId) {
      return;
    }

    const params = new URLSearchParams({
      id: selectedServiceId,
    });

    window.location.href = `agendamento.html?${params.toString()}`;
  });
}

function initManicurePage() {
  setupNextButton();
  loadManicureServices();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initManicurePage);
} else {
  initManicurePage();
}
