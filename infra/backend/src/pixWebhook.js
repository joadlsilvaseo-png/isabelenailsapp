import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(dados));
}

export function validarAssinaturaWebhookPix({
  assinatura,
  requisicaoId,
  pedidoId,
  segredo
}) {
  if (
    typeof assinatura !== "string" ||
    assinatura.length > 512 ||
    typeof requisicaoId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(requisicaoId) ||
    typeof pedidoId !== "string" ||
    !/^[A-Za-z0-9_-]{3,128}$/.test(pedidoId) ||
    typeof segredo !== "string" ||
    !segredo
  ) {
    return false;
  }

  const campos = new Map();

  for (const parte of assinatura.split(",")) {
    const componentes = parte.trim().split("=");

    if (componentes.length !== 2) return false;

    const [chave, valor] = componentes;

    if (campos.has(chave)) return false;

    campos.set(chave, valor);
  }

  const ts = campos.get("ts");
  const v1 = campos.get("v1");

  if (
    !/^\d{9,16}$/.test(ts || "") ||
    !/^[0-9a-f]{64}$/i.test(v1 || "")
  ) {
    return false;
  }

  const manifesto =
    `id:${pedidoId.toLowerCase()};` +
    `request-id:${requisicaoId};` +
    `ts:${ts};`;

  const esperado = createHmac("sha256", segredo)
    .update(manifesto)
    .digest();

  const recebido = Buffer.from(v1, "hex");

  return timingSafeEqual(esperado, recebido);
}

export async function atenderWebhookPix(req, res, pool) {
  // Desativado por padrao, inclusive na VPS.
  if (process.env.PIX_WEBHOOK_ENABLED !== "true") {
    responder(res, 404, { erro: "Rota indisponivel" });
    return;
  }

  const configuracoes = [
    { ambiente: "test", segredo: process.env.MP_WEBHOOK_SECRET_TEST },
    { ambiente: "production", segredo: process.env.MP_WEBHOOK_SECRET_PRODUCTION }
  ].filter(({ ambiente, segredo }) => segredo &&
    process.env[ambiente === "test" ? "PIX_TEST_ORDERS_ENABLED" : "PIX_PRODUCTION_ORDERS_ENABLED"] === "true");

  if (!configuracoes.length) {
    responder(res, 503, {
      erro: "Webhook nao configurado"
    });
    return;
  }

  const url = new URL(req.url, "http://localhost");

  const pedidoId = url.searchParams.get("data.id");
  const tipo = url.searchParams.get("type");

  const correspondencias = configuracoes.filter(({ segredo }) =>
    validarAssinaturaWebhookPix({
      assinatura: req.headers["x-signature"],
      requisicaoId: req.headers["x-request-id"],
      pedidoId,
      segredo
    }));

  if (correspondencias.length !== 1) {
    responder(res, 401, {
      erro: "Assinatura invalida"
    });
    return;
  }
  const ambiente = correspondencias[0].ambiente;

  if (tipo !== "order") {
    responder(res, 200, {
      recebido: true,
      ignorado: true
    });
    return;
  }

  try {
    const partes = [];
    let tamanho = 0;

    for await (const parte of req) {
      tamanho += parte.length;

      if (tamanho > 16384) {
        responder(res, 413, {
          erro: "Notificacao muito grande"
        });
        return;
      }

      partes.push(parte);
    }

    let dados;

    try {
      dados = JSON.parse(
        Buffer.concat(partes).toString("utf8")
      );
    } catch {
      responder(res, 400, {
        erro: "Notificacao invalida"
      });
      return;
    }

    if (
      dados?.type !== "order" ||
      typeof dados?.data?.id !== "string" ||
      dados.data.id.toLowerCase() !== pedidoId.toLowerCase()
    ) {
      responder(res, 400, {
        erro: "Identificador da Order divergente"
      });
      return;
    }

    if (typeof dados.live_mode === "boolean" && dados.live_mode !== (ambiente === "production")) {
      responder(res, 400, { erro: "Ambiente da notificacao divergente" });
      return;
    }

    // Armazena a notificacao para processamento posterior.
    // O webhook nao confia no status informado pelo body.
    await pool.query(`
      INSERT INTO public.pix_webhook_inbox (
        mp_environment,
        mp_order_id
      )
      VALUES ($1, $2)
      ON CONFLICT (mp_environment, mp_order_id)
      DO UPDATE SET
        ultima_notificacao_em = NOW(),
        proxima_tentativa_em = NOW(),
        processado_em = NULL,
        ultimo_erro = NULL
    `, [ambiente, pedidoId.toUpperCase()]);

    // Confirma o recebimento somente apos persistir.
    responder(res, 200, {
      recebido: true
    });
  } catch (erro) {
    console.error(
      "[PIX Webhook] Erro ao registrar notificacao:",
      erro.message
    );

    responder(res, 503, {
      erro: "Falha temporaria no recebimento"
    });
  }
}
