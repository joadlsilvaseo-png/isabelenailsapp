import { auth } from "./firebase-config.js";

const ROTA_FOTO = "/api/perfil/foto";

async function requisitarFoto(metodo, imagem = null) {
  const usuario = auth.currentUser;

  if (!usuario) {
    throw new Error("Sessão encerrada. Entre novamente.");
  }

  const token = await usuario.getIdToken();

  const headers = {
    Authorization: `Bearer ${token}`,
  };

  if (imagem) {
    headers["Content-Type"] = "image/webp";
  }

  let resposta;

  try {
    resposta = await fetch(ROTA_FOTO, {
      method: metodo,
      headers,
      ...(imagem ? { body: imagem } : {}),
      cache: "no-store",
    });
  } catch {
    throw new Error("Não foi possível conectar ao servidor.");
  }

  // Sem foto personalizada: usar a foto do Google.
  if (metodo === "GET" && resposta.status === 404) {
    return null;
  }

  if (!resposta.ok) {
    const dados = await resposta.json().catch(() => null);

    throw new Error(dados?.erro || `Erro HTTP ${resposta.status}.`);
  }

  if (metodo === "GET") {
    const tipo = resposta.headers
      .get("Content-Type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();

    if (tipo !== "image/webp") {
      throw new Error("Formato de resposta inesperado.");
    }

    return resposta.blob();
  }

  const dados = await resposta.json();

  if (dados?.ok !== true) {
    throw new Error("O servidor não confirmou a operação.");
  }

  return dados;
}

export function consultarFotoPerfil() {
  return requisitarFoto("GET");
}

export function salvarFotoPerfil(imagemWebP) {
  if (!(imagemWebP instanceof Blob) || imagemWebP.type !== "image/webp") {
    throw new Error("A foto precisa estar no formato WebP.");
  }

  return requisitarFoto("PUT", imagemWebP);
}

export function removerFotoPerfil() {
  return requisitarFoto("DELETE");
}
