import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const categoryName = "Manicure";
let selectedServiceId = null;

function clearSelection() {
  const cards = document.querySelectorAll(".manicure-card");
  cards.forEach((card) => {
    card.classList.remove("selected");
    card.setAttribute("aria-pressed", "false");
  });
}

function selectServiceCard(card) {
  clearSelection();
  card.classList.add("selected");
  card.setAttribute("aria-pressed", "true");
  selectedServiceId = card.dataset.serviceId;
}

function createServiceCard(service) {
  const listItem = document.createElement("li");
  listItem.className = "manicure-card";
  listItem.setAttribute("role", "button");
  listItem.setAttribute("tabindex", "0");
  listItem.setAttribute("aria-pressed", "false");
  listItem.dataset.serviceId = service.id;

  const priceText =
    service.preco !== undefined ? `R$ ${service.preco}` : "R$ 0";
  const durationText =
    service.duracao !== undefined ? `${service.duracao} min` : "2 horas";

  // CORREÇÃO: Fechamos as divs corretamente e removemos o parêntese indevido
  listItem.innerHTML = `
    <div class="manicure-card-text">
      <p class="manicure-card-name">${service.nome || "Serviço"}</p>
      <span class="manicure-card-label">Duração</span>
    </div>
    <div class="manicure-card-details">
      <span class="manicure-card-price">${priceText}</span>
      <span class="manicure-card-duration">${durationText}</span>
    </div>
  `;

  // Adicionamos o evento de clique após criar o elemento
  listItem.addEventListener("click", () => selectServiceCard(listItem));

  return listItem;
}

function renderServices(services) {
  const serviceList = document.getElementById("lista-servicos");
  if (!serviceList) return;

  serviceList.innerHTML = "";

  if (!services.length) {
    serviceList.innerHTML = `
      <li class="manicure-card empty-state">
        <div class="manicure-card-text">
          <p class="manicure-card-name">Nenhum serviço encontrado.</p>
          <span class="manicure-card-label">Tente novamente mais tarde.</span>
        </div>
      </li>
    `;
    return;
  }

  const fragment = document.createDocumentFragment();
  services.forEach((service) => {
    fragment.appendChild(createServiceCard(service));
  });
  serviceList.appendChild(fragment);
}

async function loadManicureServices() {
  const serviceList = document.getElementById("lista-servicos");
  if (!serviceList) return;

  const servicesRef = collection(db, "servicos");
  const servicesQuery = query(
    servicesRef,
    where("categoria", "==", categoryName),
  );

  try {
    const querySnapshot = await getDocs(servicesQuery);
    const services = querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    renderServices(services);
  } catch (error) {
    console.error("Erro ao carregar serviços de manicure:", error);
    serviceList.innerHTML = `
      <li class="manicure-card error-state">
        <div class="manicure-card-text">
          <p class="manicure-card-name">Erro ao carregar serviços.</p>
          <span class="manicure-card-label">Verifique sua conexão e tente novamente.</span>
        </div>
      </li>
    `;
  }
}

function setupNextButton() {
  const nextButton = document.querySelector(".manicure-button");
  if (!nextButton) return;

  nextButton.addEventListener("click", function (event) {
    if (!selectedServiceId) {
      event.preventDefault();
      alert("Selecione um serviço antes de continuar.");
      return;
    }

    event.preventDefault();
    window.location.href = `agendamento.html?id=${selectedServiceId}`;
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadManicureServices();
    setupNextButton();
  });
} else {
  loadManicureServices();
  setupNextButton();
}
