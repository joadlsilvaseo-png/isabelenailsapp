(async function () {
  const serviceList = document.querySelector(".unhas-list");
  const serviceCount = document.getElementById("unhas-service-count");
  const actionButton = document.querySelector(".unhas-action-button");
  const selectionSummary = document.getElementById("selected-service-summary");

  const categoryName = "Unhas em Gel";

  let selectedServiceId = null;
  let selectedServiceName = "";

  if (!serviceList) return;

  const defaultDescriptions = {
    "fibra de vidro":
      "Alongamento feito com fios de fibra moldados sobre a unha natural, proporcionando resistência, leveza e acabamento delicado.",

    alongamento:
      "Extensão construída em gel para aumentar o comprimento e definir o formato das unhas com aparência natural.",

    "alongamento em gel":
      "Extensão construída em gel para aumentar o comprimento e definir o formato das unhas com aparência natural.",

    "banho de gel":
      "Camada de gel aplicada sobre a unha natural para reforçar, nivelar e aumentar a durabilidade do acabamento.",

    blindagem:
      "Proteção fina aplicada sobre a unha natural para ajudar a reduzir quebras e descamações, sem criar alongamento.",

    manutencao:
      "Reposição e nivelamento da área de crescimento para preservar a estrutura, o formato e o acabamento do alongamento.",

    remocao:
      "Retirada técnica e cuidadosa do produto, realizada para preservar a saúde e a integridade das unhas naturais.",
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
      "Procedimento realizado com técnica profissional, cuidado e acabamento personalizado para valorizar suas unhas."
    );
  }

  function formatPrice(value) {
    if (value === undefined || value === null || value === "") {
      return "Valor a consultar";
    }

    const rawValue = String(value)
      .trim()
      .replace(/R\$/gi, "")
      .replace(/\s/g, "");

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

    if (normalizedName.includes("manutencao")) {
      return `
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M20 7V3M20 3H16M20 3L16.5 6.5C15.3 5.3 13.7 4.5 12 4.5C8.4 4.5 5.5 7.4 5.5 11"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <path
            d="M4 17V21M4 21H8M4 21L7.5 17.5C8.7 18.7 10.3 19.5 12 19.5C15.6 19.5 18.5 16.6 18.5 13"
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

    if (
      normalizedName.includes("blindagem") ||
      normalizedName.includes("banho")
    ) {
      return `
        <svg viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3L19 6V11C19 15.5 16.2 19.4 12 21C7.8 19.4 5 15.5 5 11V6L12 3Z"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          <path
            d="M9 12L11 14L15.5 9.5"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      `;
    }

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

  async function loadFirestoreServices() {
    const { db } = await import("./firebase-config.js");

    const firestore =
      await import("https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js");

    const servicesRef = firestore.collection(db, "servicos");

    const servicesQuery = firestore.query(
      servicesRef,
      firestore.where("categoria", "==", categoryName),
    );

    const querySnapshot = await firestore.getDocs(servicesQuery);

    const services = querySnapshot.docs.map((serviceDoc) => ({
      id: serviceDoc.id,
      ...serviceDoc.data(),
    }));

    return services
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
  }

  function clearSelection() {
    const cards = serviceList.querySelectorAll(".unhas-card");

    cards.forEach((card) => {
      card.classList.remove("selected");
      card.setAttribute("aria-pressed", "false");
    });
  }

  function selectCard(card) {
    clearSelection();

    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");

    selectedServiceId = card.dataset.serviceId || null;

    selectedServiceName = card.dataset.serviceName || "Serviço selecionado";

    if (actionButton) {
      actionButton.disabled = false;
    }

    if (selectionSummary) {
      selectionSummary.textContent = `${selectedServiceName} selecionado`;
    }
  }

  function setupCardBehavior(card) {
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", "false");

    card.addEventListener("click", () => {
      selectCard(card);
    });

    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      selectCard(card);
    });
  }

  function createServiceCard(service) {
    const serviceName = service.nome || "Serviço";

    const card = document.createElement("li");

    card.className = "unhas-card";
    card.dataset.serviceId = service.id;
    card.dataset.serviceName = serviceName;

    card.setAttribute("aria-label", `Selecionar ${serviceName}`);

    const cardTop = document.createElement("div");
    cardTop.className = "unhas-card-top";

    const icon = document.createElement("span");
    icon.className = "unhas-card-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = getServiceIcon(serviceName);

    const content = document.createElement("div");
    content.className = "unhas-card-content";

    const title = document.createElement("p");
    title.className = "unhas-card-title";
    title.textContent = serviceName;

    const description = document.createElement("p");
    description.className = "unhas-card-description";
    description.textContent = getServiceDescription(service);

    const check = document.createElement("span");
    check.className = "unhas-card-check";
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

    content.appendChild(title);
    content.appendChild(description);

    cardTop.appendChild(icon);
    cardTop.appendChild(content);
    cardTop.appendChild(check);

    const meta = document.createElement("div");
    meta.className = "unhas-card-meta";

    const duration = document.createElement("span");
    duration.className = "unhas-card-duration";

    duration.innerHTML = `
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

    duration.appendChild(durationText);

    const price = document.createElement("strong");
    price.className = "unhas-card-price";
    price.textContent = formatPrice(service.preco);

    meta.appendChild(duration);
    meta.appendChild(price);

    card.appendChild(cardTop);
    card.appendChild(meta);

    setupCardBehavior(card);

    return card;
  }

  function renderState(title, message) {
    serviceList.innerHTML = "";

    const stateCard = document.createElement("li");
    stateCard.className = "unhas-state-card";

    const stateTitle = document.createElement("strong");
    stateTitle.textContent = title;

    const stateMessage = document.createElement("span");
    stateMessage.textContent = message;

    stateCard.appendChild(stateTitle);
    stateCard.appendChild(stateMessage);
    serviceList.appendChild(stateCard);
  }

  function renderServices(services) {
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

  function setupNextButton() {
    if (!actionButton) return;

    actionButton.disabled = true;

    actionButton.addEventListener("click", () => {
      if (!selectedServiceId) {
        return;
      }

      const params = new URLSearchParams({
        id: selectedServiceId,
      });

      window.location.href = `agendamento.html?${params.toString()}`;
    });
  }

  async function initPage() {
    setupNextButton();

    try {
      const services = await loadFirestoreServices();

      renderServices(services);
    } catch (error) {
      console.error("Erro ao carregar serviços de unhas em gel:", error);

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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPage);
  } else {
    initPage();
  }
})();
