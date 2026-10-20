import sharp from "sharp";
import { verificarUsuario } from "./pushSubscriptions.js";

const LIMITE_UPLOAD = 10 * 1024 * 1024;
const LIMITE_BANCO = 1024 * 1024;
const FORMATOS = new Set(["image/jpeg", "image/png", "image/webp"]);
const UID_VALIDO = /^[A-Za-z0-9_-]{1,128}$/;

function erroHttp(status, mensagem) {
  return Object.assign(new Error(mensagem), { status });
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

async function receberImagem(req) {
  const tipo = String(req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!FORMATOS.has(tipo)) {
    throw erroHttp(415, "Formato de imagem não permitido.");
  }

  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > LIMITE_UPLOAD) {
      throw erroHttp(413, "A imagem excede 10 MB.");
    }

    partes.push(parte);
  }

  if (!tamanho) {
    throw erroHttp(400, "Imagem vazia.");
  }

  return Buffer.concat(partes);
}

async function otimizarImagem(arquivo) {
  try {
    const opcoes = {
      limitInputPixels: 40_000_000,
      failOn: "error",
    };

    const metadados = await sharp(arquivo, opcoes).metadata();

    if (
      !["jpeg", "png", "webp"].includes(metadados.format) ||
      (metadados.pages || 1) !== 1
    ) {
      throw erroHttp(415, "Imagem não suportada.");
    }

    for (const qualidade of [82, 70]) {
      const imagem = await sharp(arquivo, opcoes)
        .rotate()
        .resize(512, 512, {
          fit: "cover",
          position: "centre",
        })
        .webp({ quality: qualidade, effort: 4 })
        .toBuffer();

      if (imagem.length <= LIMITE_BANCO) {
        return imagem;
      }
    }

    throw erroHttp(413, "Não foi possível reduzir a foto para 1 MB.");
  } catch (erro) {
    if (erro.status) throw erro;
    throw erroHttp(400, "Arquivo de imagem inválido.");
  }
}

async function obterFirestore() {
  const { getApps, initializeApp, applicationDefault } =
    await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: "isabele-nails-app",
    });
  }

  return getFirestore();
}

async function verificarAdminAtivo(uid) {
  const db = await obterFirestore();
  const usuario = await db.collection("usuarios").doc(uid).get();
  const dados = usuario.data();

  return dados?.role === "admin" && dados?.ativo === true;
}

async function enviarFoto(res, pool, uid) {
  const resultado = await pool.query(
    "SELECT imagem FROM public.fotos_perfil WHERE firebase_uid = $1",
    [uid],
  );

  if (!resultado.rows.length) {
    responder(res, 404, { erro: "Foto personalizada não encontrada." });
    return;
  }

  const imagem = resultado.rows[0].imagem;

  res.writeHead(200, {
    "Content-Type": "image/webp",
    "Content-Length": imagem.length,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });

  res.end(imagem);
}

async function verificarContaAtiva(uid) {
  const db = await obterFirestore();

  const usuario = await db.collection("usuarios").doc(uid).get();

  if (usuario.exists) {
    const dados = usuario.data();

    return dados?.ativo === true && ["admin", "cliente"].includes(dados?.role);
  }

  // Compatibilidade com clientes antigas:
  // exige cadastro real na coleção clientes.
  const cliente = await db.collection("clientes").doc(uid).get();

  if (!cliente.exists) {
    return false;
  }

  const dados = cliente.data();

  return dados?.ativo !== false && dados?.role !== "admin";
}

export async function atenderFotosPerfil(req, res, pool, dependencies = {}) {
  let uid;

  try {
    uid = await (dependencies.verificarUsuario || verificarUsuario)(req);
  } catch {
    responder(res, 401, { erro: "Usuário não autenticado." });
    return;
  }

  try {
    const contaAtiva = await (
      dependencies.verificarContaAtiva || verificarContaAtiva
    )(uid);

    if (!contaAtiva) {
      responder(res, 403, {
        erro: "Conta desativada ou sem permissão.",
      });
      return;
    }

    const caminho = new URL(req.url, "http://localhost").pathname;

    // A administradora pode consultar fotos das clientes.
    const consultaAdmin = /^\/admin\/clientes\/([^/]+)\/foto$/.exec(caminho);

    if (consultaAdmin && req.method === "GET") {
      const clienteUid = consultaAdmin[1];

      if (!UID_VALIDO.test(clienteUid)) {
        throw erroHttp(400, "Identificador inválido.");
      }

      if (
        !(await (dependencies.verificarAdminAtivo || verificarAdminAtivo)(uid))
      ) {
        throw erroHttp(403, "Acesso administrativo negado.");
      }

      const db = await (dependencies.obterFirestore || obterFirestore)();
      const cliente = await db.collection("clientes").doc(clienteUid).get();

      if (!cliente.exists || cliente.data()?.role === "admin") {
        throw erroHttp(404, "Cliente não encontrada.");
      }

      await enviarFoto(res, pool, clienteUid);
      return;
    }

    if (caminho !== "/perfil/foto") {
      responder(res, 404, { erro: "Rota não encontrada." });
      return;
    }

    // Consultar a própria foto.
    if (req.method === "GET") {
      await enviarFoto(res, pool, uid);
      return;
    }

    // Salvar ou substituir a própria foto.
    if (req.method === "PUT") {
      const arquivo = await receberImagem(req);
      const imagem = await otimizarImagem(arquivo);

      await pool.query(
        `
        INSERT INTO public.fotos_perfil
          (firebase_uid, imagem, tipo_mime)
        VALUES ($1, $2, 'image/webp')
        ON CONFLICT (firebase_uid)
        DO UPDATE SET
          imagem = EXCLUDED.imagem,
          tipo_mime = EXCLUDED.tipo_mime,
          atualizado_em = NOW()
      `,
        [uid, imagem],
      );

      responder(res, 200, {
        ok: true,
        mensagem: "Foto de perfil salva.",
      });
      return;
    }

    // Remover a personalização.
    if (req.method === "DELETE") {
      await pool.query(
        "DELETE FROM public.fotos_perfil WHERE firebase_uid = $1",
        [uid],
      );

      responder(res, 200, {
        ok: true,
        mensagem: "Foto personalizada removida.",
      });
      return;
    }

    responder(res, 405, { erro: "Método não permitido." });
  } catch (erro) {
    if (erro.status) {
      responder(res, erro.status, { erro: erro.message });
      return;
    }

    console.error("[Fotos de perfil]", erro.message);

    responder(res, 500, {
      erro: "Não foi possível processar a foto de perfil.",
    });
  }
}
