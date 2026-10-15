(function (window, document) {
  const App = {
    onReady(callback) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", callback);
      } else {
        callback();
      }
    },

    registerServiceWorker() {
      if (!("serviceWorker" in navigator)) {
        return;
      }

      window.addEventListener("load", async () => {
        try {
          const registration = await navigator.serviceWorker.register(
            "./service-worker.js",
            {
              scope: "./",
              updateViaCache: "none",
            },
          );

          console.log("Service Worker registrado:", registration.scope);
        } catch (error) {
          console.warn("Falha ao registrar Service Worker:", error);
        }
      });
    },

    initHistoryBackLinks() {
      const backLinks = Array.from(
        document.querySelectorAll('a[data-back="history"]'),
      );
      backLinks.forEach((link) => {
        link.addEventListener("click", function (event) {
          if (window.history.length > 1) {
            event.preventDefault();
            window.history.back();
          }
        });
      });
    },

    enableTouchFeedback(selectors) {
      const buttons = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)),
      );
      if (!buttons.length) return;

      buttons.forEach((button) => {
        button.addEventListener(
          "touchstart",
          () => button.classList.add("touch-active"),
          { passive: true },
        );
        button.addEventListener("touchend", () =>
          button.classList.remove("touch-active"),
        );
        button.addEventListener("touchcancel", () =>
          button.classList.remove("touch-active"),
        );
      });
    },

    isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
        String(email).trim().toLowerCase(),
      );
    },

    isValidPhone(phone) {
      const digits = String(phone).replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 11;
    },

    initSelectableCards(options) {
      const {
        containerSelector,
        cardSelector,
        titleSelector,
        activeClass,
        storageKey,
        storageValue = { category: "", name: "" },
      } = options;

      const container = document.querySelector(containerSelector);
      if (!container) return;

      const cards = Array.from(container.querySelectorAll(cardSelector));
      if (!cards.length) return;

      function clearActive() {
        cards.forEach((card) => {
          card.classList.remove(activeClass);
          card.setAttribute("aria-pressed", "false");
        });
      }

      function handleSelection(card) {
        clearActive();
        card.classList.add(activeClass);
        card.setAttribute("aria-pressed", "true");

        const titleEl = card.querySelector(titleSelector);
        const value = titleEl ? titleEl.textContent.trim() : "";
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ ...storageValue, name: value }),
        );
      }

      cards.forEach((card) => {
        card.setAttribute("tabindex", "0");
        card.setAttribute("role", "button");
        card.setAttribute("aria-pressed", "false");

        card.addEventListener("click", () => handleSelection(card));
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleSelection(card);
          }
        });
      });
    },
  };

  window.App = App;

  App.onReady(() => {
    App.registerServiceWorker();

    /* AVISO DE INSTALAÇÃO NO IPHONE */
    const avisoIos = document.getElementById("ios-install-overlay");

    const dispositivoIphone = /iPhone|iPod/i.test(navigator.userAgent);

    const aplicativoInstalado =
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;

    if (avisoIos && dispositivoIphone && !aplicativoInstalado) {
      let avisoDispensado = false;

      try {
        avisoDispensado =
          sessionStorage.getItem("isabele-ios-install-dismissed") === "1";
      } catch (erro) {
        console.warn("[PWA] Armazenamento indisponível:", erro);
      }

      if (!avisoDispensado) {
        const fecharAviso = () => {
          avisoIos.hidden = true;

          try {
            sessionStorage.setItem("isabele-ios-install-dismissed", "1");
          } catch (erro) {
            console.warn("[PWA] Não foi possível salvar preferência:", erro);
          }
        };

        const botaoFechar = avisoIos.querySelector(".ios-install-close");
        const botaoConfirmar = avisoIos.querySelector(".ios-install-confirm");

        botaoFechar?.addEventListener("click", fecharAviso);
        botaoConfirmar?.addEventListener("click", fecharAviso);

        avisoIos.addEventListener("click", (evento) => {
          if (evento.target === avisoIos) fecharAviso();
        });

        avisoIos.addEventListener("keydown", (evento) => {
          if (evento.key === "Escape") fecharAviso();
        });

        avisoIos.hidden = false;
        botaoFechar?.focus();
      }
    }

    App.initHistoryBackLinks();
    App.enableTouchFeedback([
      "button",
      "a.button",
      ".button",
      ".manicure-button",
      ".pedicure-button",
      ".unhas-action-button",
      ".confirmacao-button",
    ]);

    // ADIÇÃO: Proteção para não quebrar a página de pedicure
    // Se a página for "pedicure", a função initSelectableCards não é chamada automaticamente
    // para evitar conflito com a lógica do Firebase que você criou no pedicure.js
    if (document.body.dataset.page === "principal") {
      // Mantenha aqui as configs que você já usava para os cards da página principal
      App.initSelectableCards({
        containerSelector: ".services-list",
        cardSelector: "li",
        titleSelector: ".service-label",
        activeClass: "selected",
        storageKey: "servicoSelecionado",
      });
    }
  });
})(window, document);
