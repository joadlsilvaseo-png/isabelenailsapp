/**
 * Função para carregar a vitrine localmente.
 * Busca as 4 primeiras imagens na pasta assets/ seguindo o padrão: vitrine-n.png
 */
let imagensVitrine = [];
let currentIndex = 0;

async function carregarVitrine() {
  const galeriaRow = document.querySelector(".gallery-row");

  if (!galeriaRow) {
    console.warn("Elemento .gallery-row não encontrado");
    return;
  }

  const imagensValidas = [];

  // Limite de 4: Tenta carregar as imagens vitrine-1, vitrine-2, vitrine-3 e vitrine-4
  for (let i = 1; i <= 4; i++) {
    const src = `./assets/vitrine-${i}.png`;

    try {
      const existe = await verificarImagem(src);

      if (existe) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = `Trabalho em destaque ${i}`;
        img.className = "vitrine-img"; // Mantendo a classe de design solicitada
        img.loading = "lazy";

        const indexAtual = imagensValidas.length;
        img.addEventListener("click", () => abrirLightboxVitrine(indexAtual));

        imagensValidas.push(img);
        imagensVitrine.push(src);
      }
    } catch (error) {
      console.error(`Erro ao processar ${src}:`, error);
      break;
    }
  }

  // Só limpa o container e renderiza se encontramos imagens, ou exibe o placeholder
  if (imagensValidas.length > 0) {
    galeriaRow.innerHTML = "";
    imagensValidas.forEach((img) => galeriaRow.appendChild(img));
  } else {
    exibirPlaceholderVitrine(galeriaRow);
  }
  setupLightboxVitrine();
}

/**
 * Lógica do Lightbox para a Vitrine
 */
function abrirLightboxVitrine(index) {
  const lightbox = document.getElementById("lightbox");
  const carousel = document.getElementById("lightbox-carousel");

  currentIndex = index;

  // Popula o carrossel com imagens da vitrine
  carousel.innerHTML = "";
  imagensVitrine.forEach((src) => {
    const img = document.createElement("img");
    img.src = src;
    img.className = "carousel-img";
    carousel.appendChild(img);
  });

  lightbox.classList.remove("hidden");
  lightbox.classList.add("active");

  setTimeout(() => atualizarPosicaoVitrine(), 50);
}

function atualizarPosicaoVitrine() {
  const carousel = document.getElementById("lightbox-carousel");
  if (carousel) {
    carousel.scrollTo({
      left: carousel.offsetWidth * currentIndex,
      behavior: "smooth",
    });
  }
}

function setupLightboxVitrine() {
  const lightbox = document.getElementById("lightbox");
  const carousel = document.getElementById("lightbox-carousel");
  const closeBtn = document.getElementById("lightbox-close");
  const prevBtn = document.getElementById("lightbox-prev");
  const nextBtn = document.getElementById("lightbox-next");

  if (!lightbox || !carousel) return;

  closeBtn.onclick = () => {
    lightbox.classList.remove("active");
    lightbox.classList.add("hidden");
  };

  lightbox.onclick = (e) => {
    if (e.target === lightbox || e.target.id === "lightbox-content") {
      closeBtn.onclick();
    }
  };

  prevBtn.onclick = () => {
    if (currentIndex > 0) {
      currentIndex--;
      atualizarPosicaoVitrine();
    }
  };
  nextBtn.onclick = () => {
    if (currentIndex < imagensVitrine.length - 1) {
      currentIndex++;
      atualizarPosicaoVitrine();
    }
  };

  carousel.addEventListener("scroll", () => {
    currentIndex = Math.round(
      carousel.scrollLeft / (carousel.offsetWidth || 1),
    );
  });
}

/**
 * Função auxiliar para verificar se a imagem existe usando HEAD (evita erro 404 no console)
 */
async function verificarImagem(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch (error) {
    return false;
  }
}

/**
 * Força a exibição de um placeholder caso nenhuma imagem seja encontrada
 */
function exibirPlaceholderVitrine(container) {
  // Limpa o container para garantir que não haja lixo visual
  container.innerHTML = "";

  const placeholder = document.createElement("div");
  // Estilo inline para garantir que o espaço não desapareça independente do CSS externo
  placeholder.style.cssText = `
    width: 100%;
    min-height: 200px;
    background: #f0c1d1;
    border-radius: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #591c31;
    font-weight: 600;
    text-align: center;
    padding: 20px;
    border: 2px dashed rgba(89, 28, 49, 0.2);
  `;
  placeholder.innerHTML =
    "📸 Novidades em breve!<br>Nossos últimos trabalhos aparecerão aqui.";
  container.appendChild(placeholder);
}

// Carrega a vitrine quando o DOM está pronto
document.addEventListener("DOMContentLoaded", carregarVitrine);
