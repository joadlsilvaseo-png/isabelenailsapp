import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";

import { getFirestore } from "firebase-admin/firestore";
import { verificarUsuario } from "./pushSubscriptions.js";

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(dados));
}

function converterPrecoCentavos(valor) {
  if (typeof valor === "number") {
    const centavos = Math.round(valor * 100);

    if (!Number.isSafeInteger(centavos) || centavos <= 0) {
      throw new Error("Preco invalido");
    }

    return centavos;
  }

  const texto = String(valor ?? "")
    .trim()
    .replace(/^R\$\s*/i, "")
    .replace(/\s/g, "");

  let normalizado;

  if (texto.includes(",")) {
    // Exemplo: R$ 1.250,50
    normalizado = texto.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(texto)) {
    // Exemplo: 1.250
    normalizado = texto.replace(/\./g, "");
  } else {
    // Exemplo: 125.50
    normalizado = texto;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalizado)) {
    throw new Error("Preco invalido");
  }

  const [inteiros, decimais = ""] = normalizado.split(".");

  const centavos = Number(inteiros) * 100 + Number(decimais.padEnd(2, "0"));

  if (!Number.isSafeInteger(centavos) || centavos <= 0) {
    throw new Error("Preco invalido");
  }

  return centavos;
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

    // Configuracao financeira controlada no PostgreSQL.
    const configuracao = await pool.query(`
      SELECT ativo, percentual_padrao, reserva_minutos
      FROM public.pix_configuracao
      WHERE id = 1
    `);

    const regra = configuracao.rows[0];

    if (!regra?.ativo || !regra.percentual_padrao) {
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

    let valorTotal;

    try {
      valorTotal = converterPrecoCentavos(dadosServico.preco);
    } catch {
      responder(res, 422, {
        erro: "Servico sem preco valido para pagamento",
      });
      return;
    }

    const percentual = Number(regra.percentual_padrao);
    const pontosPercentuais = Math.round(percentual * 100);

    if (
      !Number.isFinite(percentual) ||
      pontosPercentuais < 1 ||
      pontosPercentuais > 10000
    ) {
      responder(res, 422, {
        erro: "Percentual de sinal invalido",
      });
      return;
    }

    const valorSinal = Math.round((valorTotal * pontosPercentuais) / 10000);

    if (valorSinal <= 0 || valorSinal > valorTotal) {
      responder(res, 422, {
        erro: "Valor do sinal invalido",
      });
      return;
    }

    responder(res, 200, {
      servicoId,
      servico: dadosServico.nome || "Servico",
      valorTotalCentavos: valorTotal,
      percentualSinal: percentual,
      valorSinalCentavos: valorSinal,
      valorRestanteCentavos: valorTotal - valorSinal,
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
