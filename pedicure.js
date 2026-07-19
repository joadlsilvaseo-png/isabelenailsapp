import { db } from "./firebase-config.js";

import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const categoryName = "Pedicure";

const serviceList = document.getElementById("lista-servicos");

const serviceCount = document.getElementById("pedicure-service-count");

const nextButton = document.querySelector(".pedicure-button");

const selectionSummary = document.getElementById("selected-service-summary");

let selectedServiceId = null;
let selectedServiceName = "";

const defaultDescriptions = {
  pedicure:
    "Cuidado completo das unhas dos pés, incluindo corte, lixamento, cutilagem e esmaltação com acabamento delicado.",

  "pedicure simples":
    "Procedimento de cuidado das unhas dos pés com preparação, cutilagem e esmaltação profissional.",

  "pedicure completa":
    "Cuidado completo das unhas dos pés com corte, lixamento, cutilagem, hidratação e esmaltação.",

  "spa dos pes":
    "Experiência de cuidado com esfoliação, hidratação e massagem para proporcionar pés macios, leves e revitalizados.",

  cutilagem:
    "Remoção cuidadosa do excesso de cutículas para manter as unhas dos pés limpas e bem cuidadas.",

  hidratacao:
    "Tratamento hidratante para ajudar a reduzir o ressecamento e proporcionar mais maciez à pele dos pés.",

  esmaltacao:
    "Preparação das unhas e aplicação do esmalte escolhido, proporcionando cor uniforme e acabamento cuidadoso.",

  "esmaltacao em gel":
    "Esmaltação em gel com secagem em cabine, oferecendo brilho intenso e maior durabilidade.",

  francesinha:
    "Acabamento clássico e delicado nas unhas dos pés, com destaque suave nas pontas.",

  "remocao de esmalte em gel":
    "Remoção técnica do esmalte em gel, realizada com cuidado para preservar as unhas naturais.",
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
    "Procedimento realizado com cuidado profissional para proporcionar pés bem cuidados, confortáveis e com acabamento delicado."
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

  if (normalizedName.includes("hidratacao")) {
    return `
      <svg viewBox="0 0 24 24" fill="none">
        <path
          d="M12 3C12 3 6 10 6 14.5C6 17.8 8.7 20.5 12 20.5C15.3 20.5 18 17.8 18 14.5C18 10 12 3 12 3Z"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <path
          d="M9 15C9.4 16.4 10.5 17.2 12 17.2"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    `;
  }

  if (
    normalizedName.includes("esmaltacao") ||
    normalizedName.includes("francesinha")
  ) {
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
        d="M12.5 20C10.3 20 8.5 18.3 8.5 16.1C8.5 14.7 9.2 13.4 10.3 12.7C9.9 11.7 9.7 10.6 9.7 9.5C9.7 6.9 11.1 4.8 12.8 4.8C14.6 4.8 15.9 6.8 15.9 9.3C15.9 11 15.4 12.4 14.5 13.5C15.7 14.2 16.5 15.5 16.5 17C16.5 18.7 14.8 20 12.5 20Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />

      <circle cx="8" cy="6" r="1" fill="currentColor" />
      <circle cx="10.5" cy="3.5" r="1" fill="currentColor" />
      <circle cx="13.5" cy="3" r="1" fill="currentColor" />
      <circle cx="16.3" cy="4" r="1" fill="currentColor" />
    </svg>
  `;
}

function clearSelection() {
  if (!serviceList) return;

  const cards = serviceList.querySelectorAll(".pedicure-card");

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

  listItem.className = "pedicure-card";

  listItem.dataset.serviceId = service.id;
  listItem.dataset.serviceName = serviceName;

  listItem.setAttribute("aria-label", `Selecionar ${serviceName}`);

  const cardTop = document.createElement("div");

  cardTop.className = "pedicure-card-top";

  const icon = document.createElement("span");

  icon.className = "pedicure-card-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = getServiceIcon(serviceName);

  const cardContent = document.createElement("div");

  cardContent.className = "pedicure-card-content";

  const cardName = document.createElement("p");

  cardName.className = "pedicure-card-name";

  cardName.textContent = serviceName;

  const cardDescription = document.createElement("p");

  cardDescription.className = "pedicure-card-description";

  cardDescription.textContent = getServiceDescription(service);

  const check = document.createElement("span");

  check.className = "pedicure-card-check";
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

  cardDetails.className = "pedicure-card-details";

  const cardDuration = document.createElement("span");

  cardDuration.className = "pedicure-card-duration";

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

  cardPrice.className = "pedicure-card-price";

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

  stateCard.className = "pedicure-state-card";

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

async function loadPedicureServices() {
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
    console.error("Erro ao carregar serviços de pedicure:", error);

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

function initPedicurePage() {
  setupNextButton();
  loadPedicureServices();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPedicurePage);
} else {
  initPedicurePage();
}
