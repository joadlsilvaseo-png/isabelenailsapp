(async function () {
  const serviceList = document.querySelector(".pedicure-list");
  const nextButton = document.querySelector(".pedicure-button");
  const categoryName = "Pedicure";
  let selectedServiceId = null;

  if (!serviceList) return;

  async function loadFirestore() {
    const [{ db }, firestore] = await Promise.all([
      import("./firebase-config.js"),
      import("https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js"),
    ]);

    return {
      db,
      collection: firestore.collection,
      query: firestore.query,
      where: firestore.where,
      getDocs: firestore.getDocs,
    };
  }

  function clearSelection() {
    const cards = Array.from(serviceList.querySelectorAll(".pedicure-card"));
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
    card.className = "pedicure-card";
    card.dataset.serviceId = service.id;

    const priceText =
      service.preco !== undefined ? `R$ ${service.preco}` : "R$ 180";
    const durationText = service.duracao !== undefined ? `${service.duracao} min` : "2 horas";

    card.innerHTML = `
      <div class="pedicure-card-text">
        <p class="pedicure-card-name">${service.nome || "Serviço"}</p>
        <span class="pedicure-card-label">Duração</span>
      </div>
      <div class="pedicure-card-details">
        <span class="pedicure-card-price">${priceText}</span>
        <span class="pedicure-card-duration">${durationText}</span>
      </div>
    `;

    setupCardBehavior(card);
    return card;
  }

  function renderServices(services) {
    serviceList.innerHTML = "";

    if (!services.length) {
      serviceList.innerHTML = `
        <li class="pedicure-card">
          <div class="pedicure-card-text">
            <p class="pedicure-card-name">Nenhum serviço encontrado.</p>
            <span class="pedicure-card-label">Tente novamente mais tarde.</span>
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
    if (!nextButton) return;

    nextButton.addEventListener("click", (event) => {
      if (!selectedServiceId) {
        event.preventDefault();
        alert("Selecione um serviço antes de continuar.");
        return;
      }

      event.preventDefault();
      window.location.href = `agendamento.html?id=${selectedServiceId}`;
    });
  }

  async function loadPedicureServices() {
    try {
      const { db, collection, query, where, getDocs } = await loadFirestore();
      const servicesRef = collection(db, "servicos");
      const servicesQuery = query(
        servicesRef,
        where("categoria", "==", categoryName),
      );
      const querySnapshot = await getDocs(servicesQuery);

      const services = querySnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      renderServices(services);
    } catch (error) {
      console.error("Erro ao carregar serviços de pedicure:", error);
      serviceList.innerHTML = `
        <li class="pedicure-card">
          <div class="pedicure-card-text">
            <p class="pedicure-card-name">Erro ao carregar serviços.</p>
            <span class="pedicure-card-label">Verifique sua conexão e tente novamente.</span>
          </div>
        </li>
      `;
    }
  }

  setupNextButton();
  await loadPedicureServices();
})();
