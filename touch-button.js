(function () {
  const selectors = ['.manicure-button', '.pedicure-button', '.unhas-action-button'];
  const buttons = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)));

  if (!buttons.length) return;

  buttons.forEach(button => {
    button.addEventListener('touchstart', () => {
      button.classList.add('touch-active');
    }, { passive: true });

    button.addEventListener('touchend', () => {
      button.classList.remove('touch-active');
    });

    button.addEventListener('touchcancel', () => {
      button.classList.remove('touch-active');
    });
  });
})();