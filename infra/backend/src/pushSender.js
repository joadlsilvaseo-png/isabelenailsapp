import webpush from "web-push";
import { verificarUsuario } from "./pushSubscriptions.js";

webpush.setVapidDetails(
  "https://github.com/joadlsilvaseo-png/isabelenailsapp",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const ultimosTestes = new Map();

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });

  res.end(JSON.stringify(dados));
}

function endpointPermitido(endpoint) {
  try {
    const url = new URL(endpoint);

    const hostsPermitidos = new Set([
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "push.services.mozilla.com",
    ]);

    return (
      url.protocol === "https:" &&
      hostsPermitidos.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export async function enviarTestePush(req, res, pool) {
  let uid;

  try {
    uid = await verificarUsuario(req);
  } catch {
    responder(res, 401, {
      erro: "Usuario nao autenticado",
    });
    return;
  }

  const agora = Date.now();
  const ultimoTeste = ultimosTestes.get(uid) || 0;

  if (agora - ultimoTeste < 60000) {
    responder(res, 429, {
      erro: "Aguarde 60 segundos entre os testes",
    });
    return;
  }

  ultimosTestes.set(uid, agora);

  try {
    const consulta = await pool.query(
      `
      SELECT id, endpoint, p256dh, auth
      FROM public.push_subscriptions
      WHERE firebase_uid = $1
      ORDER BY atualizado_em DESC
      LIMIT 5
      `,
      [uid],
    );

    if (consulta.rows.length === 0) {
      responder(res, 404, {
        erro: "Nenhum dispositivo Push cadastrado",
      });
      return;
    }

    const payload = JSON.stringify({
      title: "Isabele Mariana Nails",
      body: "Nossa primeira notificacao Web Push!",
      url: "./principal.html",
      tag: "isabele-push-teste",
    });

    let enviados = 0;
    let falhas = 0;

    for (const dispositivo of consulta.rows) {
      if (!endpointPermitido(dispositivo.endpoint)) {
        falhas++;
        continue;
      }

      const subscription = {
        endpoint: dispositivo.endpoint,
        keys: {
          p256dh: dispositivo.p256dh,
          auth: dispositivo.auth,
        },
      };

      try {
        await webpush.sendNotification(subscription, payload, { TTL: 60 });

        enviados++;
      } catch (erro) {
        falhas++;

        console.error("Falha no envio Push:", erro.statusCode || erro.message);

        if (erro.statusCode === 404 || erro.statusCode === 410) {
          await pool.query(
            `
            DELETE FROM public.push_subscriptions
            WHERE id = $1 AND firebase_uid = $2
            `,
            [dispositivo.id, uid],
          );
        }
      }
    }

    if (enviados > 0) {
      await pool.query(
        `
        INSERT INTO public.notificacoes
          (firebase_uid, tipo, titulo, mensagem)
        VALUES ($1, $2, $3, $4)
        `,
        [
          uid,
          "teste_push",
          "Isabele Mariana Nails",
          "Nossa primeira notificacao Web Push!",
        ],
      );
    }

    responder(res, enviados > 0 ? 200 : 502, {
      aceitos_pelo_servico_push: enviados,
      falhas,
      total_dispositivos: consulta.rows.length,
    });
  } catch (erro) {
    console.error("Erro no teste Push:", erro.message);

    responder(res, 500, {
      erro: "Falha ao processar notificacao",
    });
  }
}
