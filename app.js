(function (window, document) {
  const App = {
    onReady(callback) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback);
      } else {
        callback();
      }
    },

    initHistoryBackLinks() {
      const backLinks = Array.from(document.querySelectorAll('a[data-back="history"]'));
      backLinks.forEach(link => {
        link.addEventListener('click', function (event) {
          if (window.history.length > 1) {
            event.preventDefault();
            window.history.back();
          }
        });
      });
    },

    enableTouchFeedback(selectors) {
      const buttons = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));
      if (!buttons.length) return;

      buttons.forEach(button => {
        button.addEventListener('touchstart', () => button.classList.add('touch-active'), { passive: true });
        button.addEventListener('touchend', () => button.classList.remove('touch-active'));
        button.addEventListener('touchcancel', () => button.classList.remove('touch-active'));
      });
    },

    isValidEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim().toLowerCase());
    },

    isValidPhone(phone) {
      const digits = String(phone).replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 11;
    },

    initSelectableCards(options) {
      const {
        containerSelector,
        cardSelector,
        titleSelector,
        activeClass,
        storageKey,
        storageValue = { category: '', name: '' }
      } = options;

      const container = document.querySelector(containerSelector);
      if (!container) return;

      const cards = Array.from(container.querySelectorAll(cardSelector));
      if (!cards.length) return;

      function clearActive() {
        cards.forEach(card => {
          card.classList.remove(activeClass);
          card.setAttribute('aria-pressed', 'false');
        });
      }

      function handleSelection(card) {
        clearActive();
        card.classList.add(activeClass);
        card.setAttribute('aria-pressed', 'true');

        const titleEl = card.querySelector(titleSelector);
        const value = titleEl ? titleEl.textContent.trim() : '';
        window.localStorage.setItem(storageKey, JSON.stringify({ ...storageValue, name: value }));
      }

      cards.forEach(card => {
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-pressed', 'false');

        card.addEventListener('click', () => handleSelection(card));
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleSelection(card);
          }
        });
      });
    }
  };

  window.App = App;

  App.onReady(() => {
    App.initHistoryBackLinks();
    App.enableTouchFeedback([
      'button',
      'a.button',
      '.button',
      '.manicure-button',
      '.pedicure-button',
      '.unhas-action-button',
      '.confirmacao-button'
    ]);
  });
})(window, document);