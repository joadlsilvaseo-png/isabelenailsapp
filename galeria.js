import { auth } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

/**
 * Função para carregar a galeria de imagens localmente.
 * Busca arquivos na pasta assets/ seguindo o padrão: categoria-nome-numero.png
 */

let imagensPorCategoria = {};
let currentCategory = "";
let currentIndex = 0;

function syncUserProfile() {
  const photoElement = document.getElementById("foto-perfil");
  onAuthStateChanged(auth, (user) => {
    if (user && user.photoURL && photoElement) {
      photoElement.src = user.photoURL;
    }
  });
}

async function carregarGaleriaLocal() {
  const categorias = ["manicure", "pedicure", "unhas-em-gel"];

  for (const categoria of categorias) {
    const container = document.getElementById(`galeria-${categoria}`);
    if (!container) continue;

    // Limpa o container antes de carregar
    container.innerHTML = "";

    // Loop para carregar imagens sequencialmente até encontrar um erro 404
    for (let i = 1; ; i++) {
      const nomeArquivo = `assets/categoria-${categoria}-${i}.png`;

      try {
        // Testa se a imagem existe
        const existe = await verificarImagem(nomeArquivo);

        if (existe) {
          const img = document.createElement("img");
          img.src = nomeArquivo;
          img.className = "galeria-img";
          img.loading = "lazy";

          // Armazena no estado para o carrossel
          if (!imagensPorCategoria[categoria])
            imagensPorCategoria[categoria] = [];
          imagensPorCategoria[categoria].push(nomeArquivo);

          const indexImg = imagensPorCategoria[categoria].length - 1;
          img.addEventListener("click", () =>
            abrirLightbox(categoria, indexImg),
          );

          container.appendChild(img);
        } else {
          // Se não encontrou o arquivo (404), encerra o loop desta categoria
          break;
        }
      } catch (error) {
        // Para o loop em caso de erro de conexão ou outros problemas
        break;
      }
    }
  }
  setupLightbox();
}

/**
 * Troca de abas estilo Instagram
 */
window.switchTab = function (categoria, btn) {
  // Atualiza botões
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  // Atualiza containers
  document
    .querySelectorAll(".section-container")
    .forEach((c) => c.classList.remove("active"));
  document.getElementById(`section-${categoria}`).classList.add("active");

  // Reset do scroll
  window.scrollTo({
    top: document.querySelector(".tabs-nav").offsetTop - 60,
    behavior: "smooth",
  });
};

/**
 * Lógica do Lightbox
 */
function abrirLightbox(categoria, index) {
  const lightbox = document.getElementById("lightbox");
  const carousel = document.getElementById("lightbox-carousel");

  currentCategory = categoria;
  currentIndex = index;

  // Popula o carrossel com imagens da categoria
  carousel.innerHTML = "";
  imagensPorCategoria[categoria].forEach((src) => {
    const img = document.createElement("img");
    img.src = src;
    img.className = "carousel-img";
    carousel.appendChild(img);
  });

  lightbox.classList.remove("hidden");
  lightbox.classList.add("active");

  // Aguarda o render para fazer o scroll inicial
  setTimeout(() => atualizarPosicaoCarrossel(), 50);
}

function atualizarPosicaoCarrossel() {
  const carousel = document.getElementById("lightbox-carousel");
  carousel.scrollTo({
    left: carousel.offsetWidth * currentIndex,
    behavior: "smooth",
  });
}

function setupLightbox() {
  const lightbox = document.getElementById("lightbox");
  const carousel = document.getElementById("lightbox-carousel");
  const closeBtn = document.getElementById("lightbox-close");
  const prevBtn = document.getElementById("lightbox-prev");
  const nextBtn = document.getElementById("lightbox-next");

  closeBtn.onclick = () => lightbox.classList.add("hidden");

  // Fecha ao clicar no fundo
  lightbox.onclick = (e) => {
    if (e.target === lightbox || e.target.id === "lightbox-content") {
      lightbox.classList.add("hidden");
    }
  };

  // Sincroniza o index ao fazer swipe manual no mobile
  carousel.addEventListener("scroll", () => {
    currentIndex = Math.round(
      carousel.scrollLeft / (carousel.offsetWidth || 1),
    );
  });
}

/**
 * Função auxiliar para verificar se a imagem existe sem dar erro 404 no console
 */
async function verificarImagem(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch (error) {
    return false;
  }
}

// Chama a função ao carregar a página
document.addEventListener("DOMContentLoaded", carregarGaleriaLocal);
document.addEventListener("DOMContentLoaded", () => {
  carregarGaleriaLocal();
  syncUserProfile();
});
