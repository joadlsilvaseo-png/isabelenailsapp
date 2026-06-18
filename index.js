// ============================================================
// JAVASCRIPT - Página Landing (index.html)
// ============================================================

/**
 * Inicialização da página
 * Adicione funcionalidades interativas aqui conforme necessário
 */

document.addEventListener("DOMContentLoaded", function () {
  initializeLanding();
});

/**
 * Função de inicialização da landing page
 */
function initializeLanding() {
  // Adicione analytics, tracking ou outras inicializações aqui
  console.log("Landing page carregada");

  // Exemplo: Adicionar listeners aos botões
  attachButtonListeners();
}

/**
 * Anexar listeners aos botões de navegação
 */
function attachButtonListeners() {
  const buttons = document.querySelectorAll(".landing-button");

  buttons.forEach((button) => {
    button.addEventListener("click", function (e) {
      // Opcional: Adicionar feedback visual ou tracking
      console.log("Botão clicado:", this.textContent);
    });

    // Adicionar suporte a teclado
    button.addEventListener("keypress", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.click();
      }
    });
  });
}

/**
 * Função auxiliar para verificar se o app está em mobile
 */
function isMobileDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}

/**
 * Função auxiliar para loggar eventos
 */
function logEvent(eventName, eventData = {}) {
  console.log(`[Event] ${eventName}`, eventData);
  // Aqui você pode conectar a um serviço de analytics
}
