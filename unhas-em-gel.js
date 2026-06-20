(async function () {
  const serviceList = document.querySelector(".unhas-list");
  serviceList.style.opacity = "0"; // ADICIONE ESTA LINHA
  const actionButton = document.querySelector(".unhas-action-button");
  const categoryName = "Unhas em Gel";
  let selectedServiceId = null;

  if (!serviceList) return;

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
    return querySnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
  }

  function clearSelection() {
    const cards = Array.from(serviceList.querySelectorAll(".unhas-card"));
    cards.forEach((card) => {
      card.classList.remove("selected");
      card.setAttribute("aria-pressed", "false");
    });
    if (actionButton) {
      actionButton.classList.remove("enabled");
      actionButton.setAttribute("aria-disabled", "true");
    }
  }

  function selectCard(card) {
    clearSelection();
    card.classList.add("selected");
    card.setAttribute("aria-pressed", "true");
    selectedServiceId = card.dataset.serviceId || null;
    if (actionButton) {
      actionButton.classList.add("enabled");
      actionButton.removeAttribute("aria-disabled");
    }
  }

  function setupCardBehavior(card) {
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", "false");

    card.addEventListener("click", () => selectCard(card));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectCard(card);
      }
    });
  }

  function createServiceCard(service) {
    const card = document.createElement("li");
    card.className = "unhas-card";
    card.dataset.serviceId = service.id;

    const priceText =
      service.preco !== undefined ? `R$ ${service.preco}` : "R$ 180";
    const durationText =
      service.duracao !== undefined ? `${service.duracao} min` : "2 horas";

    card.innerHTML = `
      <div class="unhas-card-group">
        <p class="unhas-card-title">${service.nome || "Serviço"}</p>
        <span class="unhas-card-label">Duração</span>
      </div>
      <div class="unhas-card-meta">
        <strong class="unhas-card-price">${priceText}</strong>
        <span class="unhas-card-duration">${durationText}</span>
      </div>
    `;

    setupCardBehavior(card);
    return card;
  }

  function renderServices(services) {
    serviceList.innerHTML = "";

    if (!services.length) {
      serviceList.innerHTML = `
        <li class="unhas-card">
          <div class="unhas-card-group">
            <p class="unhas-card-title">Nenhum serviço encontrado.</p>
            <span class="unhas-card-label">Tente novamente mais tarde.</span>
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

  function setupNextButton() {
    if (!actionButton) return;

    actionButton.setAttribute("aria-disabled", "true");
    actionButton.addEventListener("click", (event) => {
      if (!selectedServiceId) {
        event.preventDefault();
        alert("Selecione um serviço antes de continuar.");
        return;
      }

      event.preventDefault();
      window.location.href = `agendamento.html?id=${selectedServiceId}`;
    });
  }

  async function initPage() {
    setupNextButton();
    try {
      const services = await loadFirestoreServices();
      renderServices(services);
      serviceList.style.transition = "opacity 0.5s ease";
      serviceList.style.opacity = "1";
    } catch (error) {
      console.error("Erro ao carregar serviços de unhas em gel:", error);
      serviceList.innerHTML = `
        <li class="unhas-card">
          <div class="unhas-card-group">
            <p class="unhas-card-title">Erro ao carregar serviços.</p>
            <span class="unhas-card-label">Verifique sua conexão e tente novamente.</span>
          </div>
        </li>
      `;
      serviceList.style.transition = "opacity 0.5s ease";
      serviceList.style.opacity = "1";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPage);
  } else {
    initPage();
  }
})();
