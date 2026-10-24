import { verificarUsuario } from "./pushSubscriptions.js";

export const FILTRO_VISIBILIDADE_CENTRAL = `
  (agendado_para IS NULL OR agendado_para <= NOW())
  AND (tipo NOT IN ('lembrete_24h', 'lembrete_1h') OR estado NOT IN ('cancelado', 'expirada'))
`;

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(dados));
}

export async function atenderCentralNotificacoes(req, res, pool, dependencias = {}) {
  let uid;

  try {
    uid = await (dependencias.verificarUsuario || verificarUsuario)(req);
  } catch {
    responder(res, 401, {
      erro: "Usuario nao autenticado",
    });
    return;
  }

  const caminho = new URL(req.url, "http://localhost").pathname;

  try {
    // Consultar histórico e total de não lidas
    if (req.method === "GET" && caminho === "/notificacoes") {
      const historico = await pool.query(
        `
        SELECT
          id::text,
          tipo,
          titulo,
          mensagem,
          destino,
          estado,
          criado_em,
          lida_em
        FROM public.push_entregas
        WHERE destinatario_uid = $1
          AND ${FILTRO_VISIBILIDADE_CENTRAL}
        ORDER BY criado_em DESC, id DESC
        LIMIT 50
        `,
        [uid],
      );

      const contador = await pool.query(
        `
        SELECT COUNT(*)::integer AS total
        FROM public.push_entregas
        WHERE destinatario_uid = $1
          AND lida_em IS NULL
          AND ${FILTRO_VISIBILIDADE_CENTRAL}
        `,
        [uid],
      );

      responder(res, 200, {
        notificacoes: historico.rows,
        naoLidas: contador.rows[0].total,
      });
      return;
    }

    // Marcar todas como lidas
    if (req.method === "PATCH" && caminho === "/notificacoes/lidas") {
      const resultado = await pool.query(
        `
        UPDATE public.push_entregas
        SET lida_em = NOW()
        WHERE destinatario_uid = $1
          AND lida_em IS NULL
          AND ${FILTRO_VISIBILIDADE_CENTRAL}
        `,
        [uid],
      );

      responder(res, 200, {
        atualizado: true,
        quantidade: resultado.rowCount,
      });
      return;
    }

    // Marcar uma notificação como lida
    const correspondencia = caminho.match(
      /^\/notificacoes\/([0-9]{1,18})\/lida$/,
    );

    if (req.method === "PATCH" && correspondencia) {
      const resultado = await pool.query(
        `
        UPDATE public.push_entregas
        SET lida_em = COALESCE(lida_em, NOW())
        WHERE id = $1
          AND destinatario_uid = $2
          AND ${FILTRO_VISIBILIDADE_CENTRAL}
        RETURNING id
        `,
        [correspondencia[1], uid],
      );

      if (resultado.rowCount === 0) {
        responder(res, 404, {
          erro: "Notificacao nao encontrada",
        });
        return;
      }

      responder(res, 200, {
        atualizado: true,
      });
      return;
    }

    responder(res, 404, {
      erro: "Rota nao encontrada",
    });
  } catch (erro) {
    console.error("[CentralNotificacoes] Erro:", erro.message);

    responder(res, 500, {
      erro: "Falha ao consultar notificacoes",
    });
  }
}
