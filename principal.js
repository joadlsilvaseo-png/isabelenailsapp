import { setupPushNotifications } from "./notificationService.js";
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const fallbackName = "Cliente";
const fallbackAvatar = "https://www.w3schools.com/howto/img_avatar2.png";

function initPrincipalPage() {
  const nameElement = document.getElementById("nome-cliente");
  const photoElement = document.getElementById("foto-perfil");

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = "login.html";
      return;
    }

    // Trava para Admins: Admins não devem acessar a visão de cliente
    try {
      const userRef = doc(db, "clientes", user.uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists() && userSnap.data().role === "admin") {
        window.location.href = "dashboard.html";
        return;
      }
    } catch (e) {
      console.error("Erro ao verificar restrição de admin:", e);
    }

    if (nameElement) {
      nameElement.innerText = user.displayName || fallbackName;
    }

    if (photoElement) {
      photoElement.src = user.photoURL || fallbackAvatar;
    }

    // Solicita permissão de notificações push
    setupPushNotifications(user.uid);

    // Render category images for service cards on the home
    renderCategoryImages();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPrincipalPage);
} else {
  initPrincipalPage();
}

// Helper: create a URL-friendly slug from a category name
function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// Render category images before the service label using naming convention
function renderCategoryImages() {
  const rows = document.querySelectorAll(".service-row");
  if (!rows.length) return;

  rows.forEach((row) => {
    const labelEl = row.querySelector(".service-label");
    const iconContainer = row.querySelector(".service-icon");
    if (!labelEl || !iconContainer) return;

    // 1. Limpeza: Remove placeholders do HTML ou imagens injetadas anteriormente
    iconContainer.innerHTML = "";

    const name = labelEl.textContent.trim();
    const slug = slugify(name);
    const src = `assets/categoria-${slug}.png`;

    const img = document.createElement("img");
    img.className = "categoria-img";
    img.src = src;
    img.alt = `Categoria ${name}`;
    img.loading = "lazy";

    iconContainer.appendChild(img);
  });
}
