import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { atenderFotosPerfil } from "../src/fotosPerfil.js";

function criarResposta() {
  return {
    status: null,
    headers: {},
    body: null,

    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },

    end(conteudo) {
      this.body = Buffer.isBuffer(conteudo)
        ? conteudo
        : JSON.parse(String(conteudo));
    },
  };
}

function criarRequisicao(method, url, imagem, tipo) {
  return {
    method,
    url,
    headers: tipo ? { "content-type": tipo } : {},

    async *[Symbol.asyncIterator]() {
      if (imagem) yield imagem;
    },
  };
}

function criarBanco() {
  const fotos = new Map();

  const pool = {
    async query(sql, parametros = []) {
      const comando = sql.replace(/\s+/g, " ").trim();

      if (comando.startsWith("INSERT INTO public.fotos_perfil")) {
        fotos.set(parametros[0], Buffer.from(parametros[1]));
        return { rows: [] };
      }

      if (comando.startsWith("SELECT imagem FROM public.fotos_perfil")) {
        const imagem = fotos.get(parametros[0]);

        return {
          rows: imagem ? [{ imagem }] : [],
        };
      }

      if (comando.startsWith("DELETE FROM public.fotos_perfil")) {
        fotos.delete(parametros[0]);
        return { rows: [] };
      }

      throw new Error(`SQL inesperado: ${comando}`);
    },
  };

  return { pool, fotos };
}

function autenticar(uid = "cliente-1", extras = {}) {
  return {
    verificarUsuario: async () => uid,
    verificarContaAtiva: async () => true,
    ...extras,
  };
}

async function criarImagemValida() {
  return sharp({
    create: {
      width: 800,
      height: 500,
      channels: 3,
      background: "#b66b88",
    },
  })
    .png()
    .toBuffer();
}

test("exige autenticação Firebase", async () => {
  const { pool } = criarBanco();
  const res = criarResposta();

  await atenderFotosPerfil(criarRequisicao("GET", "/perfil/foto"), res, pool, {
    verificarUsuario: async () => {
      throw new Error("Token inválido");
    },
  });

  assert.equal(res.status, 401);
});

test("salva foto otimizada vinculada ao UID", async () => {
  const { pool, fotos } = criarBanco();
  const res = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao(
      "PUT",
      "/perfil/foto",
      await criarImagemValida(),
      "image/png",
    ),
    res,
    pool,
    autenticar(),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const imagemSalva = fotos.get("cliente-1");

  assert.ok(imagemSalva);
  assert.ok(imagemSalva.length <= 1024 * 1024);

  const metadata = await sharp(imagemSalva).metadata();

  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
});

test("consulta apenas a própria foto", async () => {
  const { pool, fotos } = criarBanco();

  fotos.set("cliente-1", Buffer.from("foto-teste"));

  const propria = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao("GET", "/perfil/foto"),
    propria,
    pool,
    autenticar("cliente-1"),
  );

  assert.equal(propria.status, 200);
  assert.equal(propria.headers["Content-Type"], "image/webp");
  assert.ok(Buffer.isBuffer(propria.body));

  const outra = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao("GET", "/perfil/foto"),
    outra,
    pool,
    autenticar("cliente-2"),
  );

  assert.equal(outra.status, 404);
});

test("remove somente a própria personalização", async () => {
  const { pool, fotos } = criarBanco();

  fotos.set("cliente-1", Buffer.from("foto-1"));
  fotos.set("cliente-2", Buffer.from("foto-2"));

  const res = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao("DELETE", "/perfil/foto"),
    res,
    pool,
    autenticar("cliente-1"),
  );

  assert.equal(res.status, 200);
  assert.equal(fotos.has("cliente-1"), false);
  assert.equal(fotos.has("cliente-2"), true);
});

test("rejeita formatos não permitidos e imagens inválidas", async () => {
  const { pool, fotos } = criarBanco();

  const formato = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao(
      "PUT",
      "/perfil/foto",
      Buffer.from("conteudo"),
      "application/pdf",
    ),
    formato,
    pool,
    autenticar(),
  );

  assert.equal(formato.status, 415);

  const arquivo = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao(
      "PUT",
      "/perfil/foto",
      Buffer.from("nao e uma imagem"),
      "image/png",
    ),
    arquivo,
    pool,
    autenticar(),
  );

  assert.equal(arquivo.status, 400);
  assert.equal(fotos.size, 0);
});

test("rejeita uploads acima de 10 MB", async () => {
  const { pool, fotos } = criarBanco();
  const res = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao(
      "PUT",
      "/perfil/foto",
      Buffer.alloc(10 * 1024 * 1024 + 1),
      "image/png",
    ),
    res,
    pool,
    autenticar(),
  );

  assert.equal(res.status, 413);
  assert.equal(fotos.size, 0);
});

test("consulta administrativa exige admin ativo", async () => {
  const { pool, fotos } = criarBanco();

  fotos.set("cliente-1", Buffer.from("foto-cliente"));

  const caminho = "/admin/clientes/cliente-1/foto";

  const semPermissao = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao("GET", caminho),
    semPermissao,
    pool,
    autenticar("outro-usuario", {
      verificarAdminAtivo: async () => false,
    }),
  );

  assert.equal(semPermissao.status, 403);

  const comPermissao = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao("GET", caminho),
    comPermissao,
    pool,
    autenticar("admin-1", {
      verificarAdminAtivo: async () => true,

      obterFirestore: async () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({
              exists: true,
              data: () => ({ nome: "Ana", role: "cliente" }),
            }),
          }),
        }),
      }),
    }),
  );

  assert.equal(comPermissao.status, 200);
  assert.ok(Buffer.isBuffer(comPermissao.body));
});
test("conta desativada não pode acessar fotos", async () => {
  const { pool } = criarBanco();
  const res = criarResposta();

  await atenderFotosPerfil(
    criarRequisicao("GET", "/perfil/foto"),
    res,
    pool,
    autenticar("cliente-1", {
      verificarContaAtiva: async () => false,
    }),
  );

  assert.equal(res.status, 403);
});
