/* EDITOR DE FOTO DE PERFIL — ISABELE */
import { salvarFotoPerfil, removerFotoPerfil } from "./foto-perfil-api.js";

const botaoFoto = document.getElementById("editar-foto-perfil");
const campoFoto = document.getElementById("foto-perfil-arquivo");
const imagemPerfil =
  document.getElementById("foto-perfil") ||
  document.getElementById("foto-cliente");

const editor = document.getElementById("editor-foto-perfil");
const canvas = document.getElementById("editor-foto-canvas");
const zoomInput = document.getElementById("editor-foto-zoom");
const cancelar = document.getElementById("editor-foto-cancelar");
const aplicar = document.getElementById("editor-foto-aplicar");
const botaoSalvar = document.getElementById("salvar-foto-perfil");
const botaoRemover = document.getElementById("remover-foto-perfil");

if (
  botaoFoto &&
  campoFoto &&
  imagemPerfil &&
  editor &&
  canvas &&
  zoomInput &&
  cancelar &&
  aplicar
) {
  const ctx = canvas.getContext("2d");
  const TAMANHO = 320;
  const LIMITE_MB = 10;

  let imagem = null;
  let zoom = 1;
  let deslocamentoX = 0;
  let deslocamentoY = 0;
  let arrastando = false;
  let ultimoX = 0;
  let ultimoY = 0;
  let urlPreview = null;
  let fotoPendente = null;

  function escalaBase() {
    return Math.max(
      TAMANHO / imagem.naturalWidth,
      TAMANHO / imagem.naturalHeight,
    );
  }

  function limitarPosicao() {
    if (!imagem) return;

    const escala = escalaBase() * zoom;

    const limiteX = Math.max(0, (imagem.naturalWidth * escala - TAMANHO) / 2);

    const limiteY = Math.max(0, (imagem.naturalHeight * escala - TAMANHO) / 2);

    deslocamentoX = Math.max(-limiteX, Math.min(limiteX, deslocamentoX));

    deslocamentoY = Math.max(-limiteY, Math.min(limiteY, deslocamentoY));
  }

  function desenhar(destino = canvas) {
    if (!imagem) return;

    const contexto = destino.getContext("2d");
    const proporcao = destino.width / TAMANHO;
    const escala = escalaBase() * zoom * proporcao;

    const largura = imagem.naturalWidth * escala;
    const altura = imagem.naturalHeight * escala;

    const x = (destino.width - largura) / 2 + deslocamentoX * proporcao;

    const y = (destino.height - altura) / 2 + deslocamentoY * proporcao;

    contexto.clearRect(0, 0, destino.width, destino.height);

    contexto.fillStyle = "#FFFFFF";
    contexto.fillRect(0, 0, destino.width, destino.height);

    contexto.imageSmoothingEnabled = true;
    contexto.imageSmoothingQuality = "high";

    contexto.drawImage(imagem, x, y, largura, altura);
  }

  // Abrir seletor de imagem
  botaoFoto.addEventListener("click", () => {
    campoFoto.click();
  });

  // Carregar imagem no editor
  campoFoto.addEventListener("change", () => {
    const arquivo = campoFoto.files?.[0];
    campoFoto.value = "";

    if (!arquivo) return;

    const formatos = ["image/png", "image/jpeg", "image/webp"];

    if (!formatos.includes(arquivo.type)) {
      alert("Escolha uma imagem PNG, JPEG ou WebP.");
      return;
    }

    if (arquivo.size > LIMITE_MB * 1024 * 1024) {
      alert(`A imagem deve ter até ${LIMITE_MB} MB.`);
      return;
    }

    const url = URL.createObjectURL(arquivo);
    const novaImagem = new Image();

    novaImagem.onload = () => {
      URL.revokeObjectURL(url);

      imagem = novaImagem;
      zoom = 1;
      deslocamentoX = 0;
      deslocamentoY = 0;
      zoomInput.value = "1";

      desenhar();

      if (!editor.open) editor.showModal();
    };

    novaImagem.onerror = () => {
      URL.revokeObjectURL(url);
      alert("Não foi possível abrir essa imagem.");
    };

    novaImagem.src = url;
  });

  // Zoom
  zoomInput.addEventListener("input", () => {
    zoom = Number(zoomInput.value);
    limitarPosicao();
    desenhar();
  });

  // Arrastar com mouse ou dedo
  canvas.addEventListener("pointerdown", (evento) => {
    if (!imagem) return;

    arrastando = true;
    ultimoX = evento.clientX;
    ultimoY = evento.clientY;

    canvas.setPointerCapture(evento.pointerId);
  });

  canvas.addEventListener("pointermove", (evento) => {
    if (!arrastando || !imagem) return;

    const larguraVisual = canvas.getBoundingClientRect().width;
    const fator = TAMANHO / larguraVisual;

    deslocamentoX += (evento.clientX - ultimoX) * fator;
    deslocamentoY += (evento.clientY - ultimoY) * fator;

    ultimoX = evento.clientX;
    ultimoY = evento.clientY;

    limitarPosicao();
    desenhar();
  });

  function pararArraste() {
    arrastando = false;
  }

  canvas.addEventListener("pointerup", pararArraste);
  canvas.addEventListener("pointercancel", pararArraste);
  canvas.addEventListener("lostpointercapture", pararArraste);

  // Cancelar edição
  cancelar.addEventListener("click", () => {
    editor.close();
  });

  editor.addEventListener("close", () => {
    imagem = null;
    arrastando = false;
  });

  // Aplicar recorte e otimizar
  aplicar.addEventListener("click", () => {
    if (!imagem || aplicar.disabled) return;

    const resultado = document.createElement("canvas");
    resultado.width = 512;
    resultado.height = 512;

    desenhar(resultado);
    aplicar.disabled = true;

    resultado.toBlob(
      (blob) => {
        aplicar.disabled = false;

        if (!blob) {
          alert("Não foi possível processar a imagem.");
          return;
        }

        // Prévia WebP otimizada — ainda sem upload
        const novaURL = URL.createObjectURL(blob);
        const urlAnterior = urlPreview;

        urlPreview = novaURL;
        fotoPendente = blob;

        if (botaoSalvar) {
          botaoSalvar.hidden = false;
        }
        imagemPerfil.src = novaURL;

        if (urlAnterior) {
          URL.revokeObjectURL(urlAnterior);
        }

        editor.close();

        console.log("Foto WebP gerada:", Math.round(blob.size / 1024), "KB");
      },
      "image/webp",
      0.85,
    );
  });

  // SALVAR A FOTO PERSONALIZADA NO POSTGRESQL

  if (botaoSalvar) {
    botaoSalvar.addEventListener("click", async () => {
      if (!fotoPendente || botaoSalvar.disabled) return;

      const imagemParaSalvar = fotoPendente;

      botaoSalvar.disabled = true;
      botaoFoto.disabled = true;
      botaoSalvar.textContent = "Salvando...";

      try {
        await salvarFotoPerfil(imagemParaSalvar);

        fotoPendente = null;
        botaoSalvar.hidden = true;
        if (botaoRemover) {
          botaoRemover.hidden = false;
        }
        alert("Foto de perfil salva com sucesso!");
      } catch (erro) {
        alert(
          "Não foi possível salvar a foto. " +
            erro.message +
            "\n\nA imagem permanece apenas como prévia.",
        );
      } finally {
        botaoSalvar.disabled = false;
        botaoFoto.disabled = false;
        botaoSalvar.textContent = "Salvar nova foto";
      }
    });
  }

  // REMOVER FOTO PERSONALIZADA

  if (botaoRemover) {
    botaoRemover.addEventListener("click", async () => {
      if (botaoRemover.disabled) return;

      const confirmar = window.confirm(
        "Deseja remover sua foto personalizada? " +
          "A foto original do Google ou do cadastro será restaurada.",
      );

      if (!confirmar) return;

      botaoRemover.disabled = true;
      botaoRemover.textContent = "Removendo...";

      try {
        await removerFotoPerfil();

        // Recarrega os dados originais e consulta novamente a API.
        window.location.reload();
      } catch (erro) {
        alert("Não foi possível remover a foto. " + erro.message);

        botaoRemover.disabled = false;
        botaoRemover.textContent = "Remover foto personalizada";
      }
    });
  }

  window.addEventListener("pagehide", () => {
    if (urlPreview) URL.revokeObjectURL(urlPreview);
  });
}
