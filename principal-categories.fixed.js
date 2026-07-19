document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.querySelector(".search-input");
  const searchForm = document.querySelector(".search-form");
  const searchButton = document.querySelector(".search-btn");
  const serviceRows = Array.from(document.querySelectorAll(".service-row"));

  const globalDictionary = [
    { name: "Meus Agendamentos", url: "meu-perfil.html" },
    { name: "Meu Perfil", url: "meu-perfil.html" },
    { name: "Minha Conta", url: "meu-perfil.html" },
    { name: "Manicure Simples", url: "manicure.html" },
    { name: "Esmaltação", url: "manicure.html" },
    { name: "Fibra de Vidro", url: "unhas-em-gel.html" },
    { name: "Alongamento em Gel", url: "unhas-em-gel.html" },
    { name: "Banho de Gel", url: "unhas-em-gel.html" },
    { name: "Blindagem", url: "unhas-em-gel.html" },
    { name: "Pedicure Completa", url: "pedicure.html" },
    { name: "Galeria de Fotos", url: "galeria.html" },
  ];

  if (!searchInput) return;

  function normalizeText(text) {
    return String(text)
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function removeOldSuggestions() {
    document
      .querySelectorAll(".search-suggestion")
      .forEach((element) => element.remove());
  }

  function filterVisibleServices() {
    const term = normalizeText(searchInput.value);

    removeOldSuggestions();

    serviceRows.forEach((row) => {
      const labelElement = row.querySelector(".service-label");
      const listItem = row.closest("li");

      if (!labelElement || !listItem) return;

      const serviceName = normalizeText(labelElement.textContent);

      const isVisible = term === "" || serviceName.includes(term);

      listItem.style.display = isVisible ? "" : "none";
    });
  }

  function navigateToSearchResult() {
    const term = normalizeText(searchInput.value);

    if (!term) return;

    const visibleService = serviceRows.find((row) => {
      const labelElement = row.querySelector(".service-label");

      if (!labelElement) return false;

      const serviceName = normalizeText(labelElement.textContent);

      return serviceName.includes(term);
    });

    if (visibleService) {
      window.location.href = visibleService.href;
      return;
    }

    const dictionaryResult = globalDictionary.find((item) =>
      normalizeText(item.name).includes(term),
    );

    if (dictionaryResult) {
      window.location.href = dictionaryResult.url;
      return;
    }

    console.log(`Nenhum resultado encontrado para: "${term}"`);
  }

  searchInput.addEventListener("input", filterVisibleServices);

  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    navigateToSearchResult();
  });

  if (searchForm) {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      navigateToSearchResult();
    });
  }

  if (searchButton) {
    searchButton.addEventListener("click", (event) => {
      event.preventDefault();
      navigateToSearchResult();
    });
  }

  removeOldSuggestions();
  filterVisibleServices();
});
