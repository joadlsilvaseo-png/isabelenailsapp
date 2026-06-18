// navigation.js
// Handle back buttons that should return to previous page in history
// Links must keep a sensible href fallback (e.g. principal.html) and include attribute data-back="history"

document.addEventListener('DOMContentLoaded', function () {
  // Find all links that request history-based back navigation
  const backLinks = Array.from(document.querySelectorAll('a[data-back="history"]'));

  backLinks.forEach(link => {
    link.addEventListener('click', function (e) {
      // If there is history to go back to, use history.back()
      if (window.history.length > 1) {
        e.preventDefault();
        window.history.back();
      }
      // Otherwise, allow the href fallback to navigate (no change needed)
    });
  });
});
