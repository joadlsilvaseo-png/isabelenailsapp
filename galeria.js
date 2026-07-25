import { trackEvent } from "./analytics.js";

/* ============================================================
   CONFIGURAÇÃO
   ============================================================ */

const categorias = ["unhas-em-gel", "manicure", "pedicure"];

const rotulosCategorias = {
  "unhas-em-gel": "Unhas em Gel",
  manicure: "Manicure",
  pedicure: "Pedicure",
};

const imagensPorCategoria = {
  "unhas-em-gel": [],
  manicure: [],
  pedicure: [],
};

let categoriaAtual = "unhas-em-gel";

let indiceAtual = 0;

let bloqueioScrollCarousel = false;

/* ============================================================
   ELEMENTOS
   ============================================================ */

const elements = {};

function carregarElementos() {
  elements.tabs = document.querySelectorAll("[data-gallery-tab]");

  elements.sections = document.querySelectorAll("[data-gallery-section]");

  elements.lightbox = document.getElementById("lightbox");

  elements.lightboxContent = document.getElementById("lightbox-content");

  elements.carousel = document.getElementById("lightbox-carousel");

  elements.closeButton = document.getElementById("lightbox-close");

  elements.prevButton = document.getElementById("lightbox-prev");

  elements.nextButton = document.getElementById("lightbox-next");

  elements.counter = document.getElementById("lightbox-counter");
}

/* ============================================================
   CARREGAMENTO DAS IMAGENS
   ============================================================ */

async function verificarImagem(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      cache: "no-store",
    });

    return response.ok;
  } catch (error) {
    return false;
  }
}

async function buscarImagensCategoria(categoria) {
  const imagens = [];

  for (let indice = 1; ; indice += 1) {
    const caminho = `assets/categoria-${categoria}-${indice}.png`;

    const existe = await verificarImagem(caminho);

    if (!existe) {
      break;
    }

    imagens.push(caminho);
  }

  return imagens;
}

function obterElementosCategoria(categoria) {
  return {
    lista: document.getElementById(`galeria-${categoria}`),

    loading: document.querySelector(`[data-gallery-loading="${categoria}"]`),

    empty: document.querySelector(`[data-gallery-empty="${categoria}"]`),

    count: document.querySelector(`[data-gallery-count="${categoria}"]`),
  };
}

function atualizarContadorCategoria(categoria, quantidade) {
  const { count } = obterElementosCategoria(categoria);

  if (!count) {
    return;
  }

  if (quantidade === 0) {
    count.textContent = "Sem imagens";

    return;
  }

  count.textContent = quantidade === 1 ? "1 imagem" : `${quantidade} imagens`;
}

function criarCardImagem(categoria, caminho, indice) {
  const item = document.createElement("li");

  const button = document.createElement("button");

  const image = document.createElement("img");

  button.type = "button";

  button.setAttribute(
    "aria-label",
    `Ampliar imagem ${indice + 1} de ${rotulosCategorias[categoria]}`,
  );

  image.src = caminho;

  image.alt = `${rotulosCategorias[categoria]} — inspiração ${indice + 1}`;

  image.className = "gallery-image";

  image.loading = "lazy";

  image.decoding = "async";

  button.appendChild(image);

  item.appendChild(button);

  button.addEventListener("click", () => {
    abrirLightbox(categoria, indice);
  });

  return item;
}

function renderizarCategoria(categoria) {
  const { lista, loading, empty } = obterElementosCategoria(categoria);

  if (!lista) {
    return;
  }

  const imagens = imagensPorCategoria[categoria] || [];

  lista.innerHTML = "";

  if (loading) {
    loading.hidden = true;
  }

  atualizarContadorCategoria(categoria, imagens.length);

  if (imagens.length === 0) {
    lista.hidden = true;

    if (empty) {
      empty.hidden = false;
    }

    return;
  }

  if (empty) {
    empty.hidden = true;
  }

  imagens.forEach((caminho, indice) => {
    const card = criarCardImagem(categoria, caminho, indice);

    lista.appendChild(card);
  });

  lista.hidden = false;
}

async function carregarCategoria(categoria) {
  const { lista, loading, empty } = obterElementosCategoria(categoria);

  if (lista) {
    lista.hidden = true;
  }

  if (empty) {
    empty.hidden = true;
  }

  if (loading) {
    loading.hidden = false;
  }

  try {
    const imagens = await buscarImagensCategoria(categoria);

    imagensPorCategoria[categoria] = imagens;
  } catch (error) {
    console.error(`Erro ao carregar a categoria ${categoria}:`, error);

    imagensPorCategoria[categoria] = [];
  }

  renderizarCategoria(categoria);
}

async function carregarGaleria() {
  await Promise.all(
    categorias.map((categoria) => carregarCategoria(categoria)),
  );
}

/* ============================================================
   CATEGORIAS
   ============================================================ */

function selecionarCategoria(categoria) {
  if (!categorias.includes(categoria)) {
    return;
  }

  categoriaAtual = categoria;

  elements.tabs.forEach((tab) => {
    const ativa = tab.dataset.galleryTab === categoria;

    tab.classList.toggle("is-active", ativa);

    tab.setAttribute("aria-pressed", String(ativa));
  });

  elements.sections.forEach((section) => {
    const ativa = section.dataset.gallerySection === categoria;

    section.classList.toggle("is-active", ativa);

    section.hidden = !ativa;
  });

  trackEvent("gallery_tab_switch", {
    category: categoria,
  });
}

function configurarCategorias() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      selecionarCategoria(tab.dataset.galleryTab);
    });
  });
}

/* ============================================================
   LIGHTBOX
   ============================================================ */

function atualizarContadorLightbox() {
  if (!elements.counter) {
    return;
  }

  const quantidade = imagensPorCategoria[categoriaAtual]?.length || 0;

  elements.counter.textContent =
    quantidade > 0 ? `${indiceAtual + 1} de ${quantidade}` : "0 de 0";
}

function criarImagemLightbox(caminho, categoria, indice) {
  const image = document.createElement("img");

  image.src = caminho;

  image.alt = `${rotulosCategorias[categoria]} — imagem ampliada ${indice + 1}`;

  image.className = "carousel-img";

  image.decoding = "async";

  return image;
}

function montarCarousel(categoria) {
  if (!elements.carousel) {
    return;
  }

  const imagens = imagensPorCategoria[categoria] || [];

  elements.carousel.innerHTML = "";

  imagens.forEach((caminho, indice) => {
    elements.carousel.appendChild(
      criarImagemLightbox(caminho, categoria, indice),
    );
  });
}

function moverCarousel(indice, comportamento = "smooth") {
  const imagens = imagensPorCategoria[categoriaAtual] || [];

  if (imagens.length === 0 || !elements.carousel) {
    return;
  }

  const ultimoIndice = imagens.length - 1;

  if (indice < 0) {
    indiceAtual = ultimoIndice;
  } else if (indice > ultimoIndice) {
    indiceAtual = 0;
  } else {
    indiceAtual = indice;
  }

  bloqueioScrollCarousel = true;

  elements.carousel.scrollTo({
    left: elements.carousel.clientWidth * indiceAtual,

    behavior: comportamento,
  });

  atualizarContadorLightbox();

  window.setTimeout(() => {
    bloqueioScrollCarousel = false;
  }, 350);
}

function abrirLightbox(categoria, indice) {
  const imagens = imagensPorCategoria[categoria] || [];

  if (imagens.length === 0) {
    return;
  }

  categoriaAtual = categoria;

  indiceAtual = indice;

  montarCarousel(categoria);

  elements.lightbox.hidden = false;

  document.body.style.overflow = "hidden";

  atualizarContadorLightbox();

  trackEvent("gallery_image_view", {
    category: categoria,
    index: indice,
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      moverCarousel(indiceAtual, "auto");

      elements.closeButton?.focus();
    });
  });
}

function fecharLightbox() {
  if (!elements.lightbox) {
    return;
  }

  elements.lightbox.hidden = true;

  document.body.style.overflow = "";
}

function mostrarImagemAnterior() {
  moverCarousel(indiceAtual - 1);
}

function mostrarProximaImagem() {
  moverCarousel(indiceAtual + 1);
}

function sincronizarIndiceCarousel() {
  if (bloqueioScrollCarousel || !elements.carousel) {
    return;
  }

  const largura = elements.carousel.clientWidth;

  if (!largura) {
    return;
  }

  const novoIndice = Math.round(elements.carousel.scrollLeft / largura);

  const quantidade = imagensPorCategoria[categoriaAtual]?.length || 0;

  if (novoIndice < 0 || novoIndice >= quantidade) {
    return;
  }

  indiceAtual = novoIndice;

  atualizarContadorLightbox();
}

function configurarLightbox() {
  elements.closeButton?.addEventListener("click", fecharLightbox);

  elements.prevButton?.addEventListener("click", mostrarImagemAnterior);

  elements.nextButton?.addEventListener("click", mostrarProximaImagem);

  elements.lightbox?.addEventListener("click", (event) => {
    if (event.target === elements.lightbox) {
      fecharLightbox();
    }
  });

  let scrollTimeout = null;

  elements.carousel?.addEventListener(
    "scroll",
    () => {
      window.clearTimeout(scrollTimeout);

      scrollTimeout = window.setTimeout(sincronizarIndiceCarousel, 80);
    },
    {
      passive: true,
    },
  );

  document.addEventListener("keydown", (event) => {
    if (elements.lightbox?.hidden) {
      return;
    }

    if (event.key === "Escape") {
      fecharLightbox();
    }

    if (event.key === "ArrowLeft") {
      mostrarImagemAnterior();
    }

    if (event.key === "ArrowRight") {
      mostrarProximaImagem();
    }
  });
}

/* ============================================================
   INICIALIZAÇÃO
   ============================================================ */

async function inicializarGaleria() {
  carregarElementos();

  configurarCategorias();

  configurarLightbox();

  selecionarCategoria("unhas-em-gel");

  await carregarGaleria();

  trackEvent("view_gallery");
}

document.addEventListener("DOMContentLoaded", inicializarGaleria);
