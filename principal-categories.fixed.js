document.addEventListener("DOMContentLoaded", () => {
  function slugify(name) {
    return name
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\-]/g, "");
  }

  function renderServiceCards() {
    const rows = document.querySelectorAll(".service-row");
    rows.forEach((row) => {
      const labelEl = row.querySelector(".service-label");
      row.querySelectorAll("img").forEach((el) => el.remove());
      const iconContainer = row.querySelector(".service-icon");
      if (iconContainer) iconContainer.innerHTML = "";
      row.querySelectorAll(".placeholder").forEach((el) => el.remove());

      const serviceName = labelEl
        ? labelEl.textContent.trim()
        : row.textContent.trim();

      const img = document.createElement("img");
      const filename = `categoria-${serviceName.toLowerCase().replace(/\s+/g, "-")}.png`;
      const caminhoDaImagem = `./assets/${filename}`;

      img.src = caminhoDaImagem;
      img.alt = serviceName;
      img.loading = "lazy";
      img.className = "categoria-img";

      img.onerror = () => {
        if (!img.src.includes("placeholder")) {
          img.onerror = null;
          img.src = "./assets/placeholder.png";
          console.error("Falha ao carregar:", img.src);
        }
      };

      if (iconContainer) {
        iconContainer.prepend(img);
      } else {
        row.prepend(img);
      }
    });
  }

  // Dicionário de busca expandido para cobrir outras páginas e serviços específicos
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

  function initSearchFilter() {
    const searchInput = document.querySelector(".search-input");
    const serviceRows = document.querySelectorAll(".service-row");
    const servicesList = document.querySelector(".services-list");

    if (!searchInput || !servicesList) return;

    searchInput.addEventListener("input", (e) => {
      const term = e.target.value.toLowerCase().trim();

      document
        .querySelectorAll(".search-suggestion")
        .forEach((el) => el.remove());
      let foundCount = 0;

      serviceRows.forEach((row) => {
        const labelEl = row.querySelector(".service-label");
        if (!labelEl) return;
        const serviceName = labelEl.textContent.toLowerCase();
        const listItem = row.closest("li");
        const iconContainer = row.querySelector(".service-icon");

        const isMatch = term === "" || serviceName.includes(term);
        listItem.style.display = isMatch ? "" : "none";

        // Esconde o ícone se estiver em modo de busca, mostra se estiver vazio
        if (iconContainer)
          iconContainer.style.display = term !== "" ? "none" : "";

        if (isMatch && term !== "") foundCount++;
      });

      if (term !== "") {
        globalDictionary.forEach((item) => {
          const nameLower = item.name.toLowerCase();
          const alreadyVisible = Array.from(serviceRows).some(
            (r) =>
              r.closest("li").style.display !== "none" &&
              r.querySelector(".service-label").textContent.toLowerCase() ===
                nameLower,
          );

          if (nameLower.includes(term) && !alreadyVisible) {
            const li = document.createElement("li");
            li.className = "search-suggestion";
            li.innerHTML = `
              <a href="${item.url}" class="service-row">
                <span class="service-label">${item.name}</span>
                <span class="service-chevron">›</span>
              </a>
            `;
            servicesList.appendChild(li);
            foundCount++;
          }
        });
      }

      console.log(
        `Termo pesquisado: "${term}" | Serviços encontrados: ${foundCount}`,
      );
    });
  }

  renderServiceCards();
  initSearchFilter();
});
