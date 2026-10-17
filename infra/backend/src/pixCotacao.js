import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";

import { getFirestore } from "firebase-admin/firestore";
import { verificarUsuario } from "./pushSubscriptions.js";
import { calcularSinalServico } from "./pixSinalServico.js";

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(dados));
}

async function lerDados(req) {
  let conteudo = "";

  for await (const parte of req) {
    conteudo += parte.toString("utf8");

    if (Buffer.byteLength(conteudo, "utf8") > 4096) {
      const erro = new Error("Requisicao muito grande");
      erro.status = 413;
      throw erro;
    }
  }

  try {
    return JSON.parse(conteudo);
  } catch {
    const erro = new Error("JSON invalido");
    erro.status = 400;
    throw erro;
  }
}

export async function cotarSinalPix(req, res, pool) {
  try {
    // Somente clientes autenticados podem consultar.
    await verificarUsuario(req);
  } catch {
    responder(res, 401, {
      erro: "Usuario nao autenticado",
    });
    return;
  }

  try {
    const dados = await lerDados(req);

    const servicoId = dados?.servicoId;

    if (
      typeof servicoId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(servicoId)
    ) {
      responder(res, 400, {
        erro: "Servico invalido",
      });
      return;
    }

    // O PostgreSQL controla a habilitacao e o prazo da reserva. O valor do
    // sinal vem exclusivamente do documento do servico no Firestore.
    const configuracao = await pool.query(`
      SELECT ativo, reserva_minutos
      FROM public.pix_configuracao
      WHERE id = 1
    `);

    const regra = configuracao.rows[0];

    if (!regra?.ativo) {
      responder(res, 409, {
        erro: "Pagamento PIX ainda nao habilitado",
      });
      return;
    }

    // Valor do servico consultado diretamente no Firebase.
    if (!getApps().length) {
      initializeApp({
        credential: applicationDefault(),
        projectId: "isabele-nails-app",
      });
    }

    const servico = await getFirestore()
      .collection("servicos")
      .doc(servicoId)
      .get();

    if (!servico.exists || servico.data()?.ativo === false) {
      responder(res, 404, {
        erro: "Servico nao encontrado",
      });
      return;
    }

    const dadosServico = servico.data();

    let valores;
    try {
      valores = calcularSinalServico(dadosServico);
    } catch (erro) {
      responder(res, 422, {
        erro: erro.message,
      });
      return;
    }

    responder(res, 200, {
      servicoId,
      servico: dadosServico.nome || "Servico",
      ...valores,
      reservaMinutos: regra.reserva_minutos,
      cobrancaCriada: false,
    });
  } catch (erro) {
    if (erro.status === 400 || erro.status === 413) {
      responder(res, erro.status, {
        erro: erro.message,
      });
      return;
    }

    console.error("[PIX] Falha ao calcular sinal:", erro.message);

    responder(res, 500, {
      erro: "Falha ao calcular o sinal",
    });
  }
}
