(() => {
  const paginas = [
    {
      id: "principal",
      nome: "Gestão",
      href: "principal.html",
      icon: '<path d="M3 10L12 3L21 10M5 9V21H19V9M9 21V14H15V21"/>',
    },
    {
      id: "admin-agendamentos",
      nome: "Agenda",
      href: "admin-agendamentos.html",
      icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3V7M17 3V7M3 10H21M8 15H11M14 15H17"/>',
    },
    {
      id: "admin-clientes",
      nome: "Clientes",
      href: "admin-clientes.html",
      icon: '<circle cx="9" cy="8" r="3"/><path d="M2 20V18C2 15 5 13 9 13S16 15 16 18V20M17 6C19 6 21 8 21 10M18 14C21 14 23 16 23 19"/>',
    },
    {
      id: "admin-servicos",
      nome: "Serviços",
      href: "admin-servicos.html",
      icon: '<path d="M12 2L14 9L21 12L14 15L12 22L10 15L3 12L10 9Z"/>',
    },
    {
      id: "dashboard",
      nome: "Painel",
      href: "dashboard.html",
      icon: '<path d="M4 20V12M10 20V5M16 20V9M22 20V3"/>',
    },
  ];

  const paginaAtual = document.body.dataset.page;
  if (!paginas.some((p) => p.id === paginaAtual)) return;

  // Remove o menu antigo de três itens da tela Clientes.
  document
    .querySelectorAll("nav.admin-navigation")
    .forEach((menu) => menu.remove());

  if (document.getElementById("isabele-admin-bottom-nav")) return;

  const nav = document.createElement("nav");
  nav.id = "isabele-admin-bottom-nav";
  nav.className = "isabele-admin-bottom-nav";
  nav.setAttribute("aria-label", "Navegação inferior administrativa");

  for (const pagina of paginas) {
    const link = document.createElement("a");
    link.href = pagina.href;
    link.className = "isabele-admin-nav-item";

    if (pagina.id === paginaAtual) {
      link.classList.add("isabele-admin-nav-item--active");
      link.setAttribute("aria-current", "page");
    }

    link.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true">
        ${pagina.icon}
      </svg>
      <span>${pagina.nome}</span>
    `;

    nav.appendChild(link);
  }

  document.body.appendChild(nav);
})();
