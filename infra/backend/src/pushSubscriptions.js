import { createRemoteJWKSet, jwtVerify } from "jose";

const PROJECT_ID = "isabele-nails-app";

const firebasePublicKeys = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
  ),
);

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });

  res.end(JSON.stringify(dados));
}

export async function verificarUsuario(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ") || authorization.length > 6000) {
    throw new Error("Token ausente ou invalido");
  }

  const token = authorization.slice(7);

  const { payload } = await jwtVerify(token, firebasePublicKeys, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
    algorithms: ["RS256"],
  });

  const agora = Math.floor(Date.now() / 1000);

  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    payload.sub.length > 128 ||
    typeof payload.iat !== "number" ||
    payload.iat > agora ||
    typeof payload.auth_time !== "number" ||
    payload.auth_time > agora
  ) {
    throw new Error("Identidade invalida");
  }

  return payload.sub;
}

export async function registrarInscricaoPush(req, res, pool) {
  let firebaseUid;

  try {
    firebaseUid = await verificarUsuario(req);
  } catch (erro) {
    responder(res, 401, {
      erro: "Usuario nao autenticado",
    });
    return;
  }

  let corpo = "";

  try {
    for await (const parte of req) {
      corpo += parte.toString("utf8");

      if (Buffer.byteLength(corpo, "utf8") > 16384) {
        responder(res, 413, {
          erro: "Dados excedem o limite permitido",
        });
        return;
      }
    }
  } catch (erro) {
    responder(res, 400, {
      erro: "Falha na leitura dos dados",
    });
    return;
  }

  let subscription;

  try {
    subscription = JSON.parse(corpo);
  } catch (erro) {
    responder(res, 400, {
      erro: "JSON invalido",
    });
    return;
  }

  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;

  const base64url = /^[A-Za-z0-9_-]+={0,2}$/;

  let endpointUrl;

  try {
    endpointUrl = new URL(endpoint);
  } catch (erro) {
    responder(res, 400, {
      erro: "Endpoint invalido",
    });
    return;
  }

  if (
    typeof endpoint !== "string" ||
    endpoint.length > 2048 ||
    endpointUrl.protocol !== "https:" ||
    endpointUrl.username ||
    endpointUrl.password ||
    typeof p256dh !== "string" ||
    p256dh.length < 80 ||
    p256dh.length > 128 ||
    !base64url.test(p256dh) ||
    typeof auth !== "string" ||
    auth.length < 16 ||
    auth.length > 64 ||
    !base64url.test(auth)
  ) {
    responder(res, 400, {
      erro: "Inscricao Push invalida",
    });
    return;
  }

  try {
    await pool.query(
      `
      INSERT INTO public.push_subscriptions
        (firebase_uid, endpoint, p256dh, auth, dispositivo)
      VALUES ($1, $2, $3, $4, $5)

      ON CONFLICT (endpoint)
      DO UPDATE SET
        firebase_uid = EXCLUDED.firebase_uid,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        dispositivo = EXCLUDED.dispositivo,
        atualizado_em = CURRENT_TIMESTAMP
      `,
      [
        firebaseUid,
        endpoint,
        p256dh,
        auth,
        String(req.headers["user-agent"] || "").slice(0, 180),
      ],
    );

    responder(res, 201, {
      registrado: true,
      mensagem: "Dispositivo registrado com sucesso",
    });
  } catch (erro) {
    console.error("Erro ao registrar Push:", erro.message);

    responder(res, 500, {
      erro: "Falha ao registrar dispositivo",
    });
  }
}
