import {
  initializeApp,
  applicationDefault,
  getApps
} from "firebase-admin/app";

import { getAuth } from "firebase-admin/auth";
import { verificarUsuario } from "./pushSubscriptions.js";

import {
  criarPedidoPix,
  consultarPedidoPixComLock,
  mercadoPagoHabilitado
} from "./pixMercadoPago.js";

function responder(res, codigo, dados) {
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(dados));
}

function erroHttp(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { codigo });
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > 2048) {
      throw erroHttp(413, "Requisicao muito grande");
    }

    partes.push(parte);
  }

  try {
    const dados = JSON.parse(
      Buffer.concat(partes).toString("utf8")
    );

    if (
      !dados ||
      Array.isArray(dados) ||
      typeof dados !== "object"
    ) {
      throw new Error("JSON invalido");
    }

    return dados;
  } catch {
    throw erroHttp(400, "JSON invalido");
  }
}

function dinheiroCentavos(valor) {
  const texto = String(valor);

  if (!/^\d+(?:\.\d{1,2})?$/.test(texto)) {
    return null;
  }

  const [inteiro, decimal = ""] = texto.split(".");

  const centavos =
    Number(inteiro) * 100 +
    Number(decimal.padEnd(2, "0"));

  return Number.isSafeInteger(centavos)
    ? centavos
    : null;
}

function conferirPedido(pedido, cobranca) {
  const sinal = Number(cobranca.valor_sinal_centavos);

  if (
    pedido.referenciaExterna !== cobranca.referencia_externa ||
    dinheiroCentavos(pedido.valorPedido) !== sinal ||
    (
      pedido.valorPagamento != null &&
      dinheiroCentavos(pedido.valorPagamento) !== sinal
    )
  ) {
    throw new Error(
      "Order divergente da cobranca registrada"
    );
  }
}

function emailValido(email) {
  return (
    typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

export async function emitirPixDaReserva(req, res, pool) {
  let uid;

  try {
    uid = await verificarUsuario(req);
  } catch {
    responder(res, 401, {
      erro: "Nao autenticado"
    });
    return;
  }

  try {
    const { reservaId } = await lerJson(req);

    if (
      typeof reservaId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(reservaId)
    ) {
      throw erroHttp(400, "Reserva invalida");
    }

    const conexao = await pool.connect();

    let cobranca;
    let emitir = false;
    let aguardando = false;

    try {
      await conexao.query("BEGIN");

      const consulta = await conexao.query(`
        SELECT
          c.*,
          r.estado AS reserva_estado,
          r.vence_em AS reserva_vence_em,
          cfg.ativo AS pix_ativo
        FROM public.pix_reservas r
        JOIN public.pix_cobrancas c
          ON c.id = r.cobranca_id
        JOIN public.pix_configuracao cfg
          ON cfg.id = 1
        WHERE r.id = $1
          AND r.cliente_uid = $2
          AND c.cliente_uid = $2
        FOR UPDATE OF r, c
      `, [reservaId, uid]);

      cobranca = consulta.rows[0];

      if (!cobranca) {
        throw erroHttp(404, "Reserva nao encontrada");
      }

      cobranca.mp_environment ||= "test";
      if (!mercadoPagoHabilitado(cobranca.mp_environment)) {
        throw erroHttp(409, `Operacoes PIX desativadas para ${cobranca.mp_environment}`);
      }

      if (!cobranca.pix_ativo) {
        throw erroHttp(409, "PIX desativado");
      }

      if (cobranca.reserva_estado !== "reservada") {
        throw erroHttp(409, "Reserva nao esta ativa");
      }

      if (cobranca.estado === "paga") {
        throw erroHttp(409, "Pagamento ja confirmado");
      }

      if (!cobranca.mp_order_id) {
        if (!["criada", "pendente"].includes(cobranca.estado)) {
          throw erroHttp(409, "Cobranca indisponivel");
        }

        // O PIX tera 30 minutos de validade.
        // Mantemos uma margem adicional de 5 minutos.
        const tempoRestante =
          new Date(cobranca.reserva_vence_em).getTime() -
          Date.now();

        if (tempoRestante < 35 * 60000) {
          throw erroHttp(
            409,
            "Reserva sem tempo suficiente para gerar PIX"
          );
        }

        const segundosDesdeUltimaTentativa =
          (Date.now() -
            new Date(cobranca.atualizado_em).getTime()) / 1000;

        if (
          cobranca.estado === "pendente" &&
          segundosDesdeUltimaTentativa < 45
        ) {
          aguardando = true;
        } else {
          let email = cobranca.reserva_dados?.emailPagador;

          if (!email) {
            if (!getApps().length) {
              initializeApp({
                credential: applicationDefault(),
                projectId: "isabele-nails-app"
              });
            }

            const usuario = await getAuth().getUser(uid);
            email = usuario.email;
          }

          if (!emailValido(email)) {
            throw erroHttp(
              422,
              "Conta da cliente sem email valido"
            );
          }

          // Marca como pendente ANTES da chamada externa.
          // Preserva o email para retries identicos.
          const atualizacao = await conexao.query(`
            UPDATE public.pix_cobrancas
            SET
              estado = 'pendente',
              atualizado_em = NOW(),
              reserva_dados = jsonb_set(
                reserva_dados,
                '{emailPagador}',
                to_jsonb($2::text),
                true
              )
            WHERE id = $1
          `, [cobranca.id, email]);

          if (atualizacao.rowCount !== 1) {
            throw new Error("Falha ao preparar cobranca");
          }

          cobranca.reserva_dados = {
            ...cobranca.reserva_dados,
            emailPagador: email
          };

          emitir = true;
        }
      }

      await conexao.query("COMMIT");
    } catch (erro) {
      await conexao.query("ROLLBACK").catch(() => {});
      throw erro;
    } finally {
      conexao.release();
    }

    if (aguardando) {
      responder(res, 202, {
        status: "processando",
        mensagem: "Geracao do PIX em andamento"
      });
      return;
    }

    // A chave de idempotencia vem do PostgreSQL.
    // O navegador nunca escolhe valor, referencia ou email.
    const pedido = emitir
      ? await criarPedidoPix({
          valorCentavos: Number(cobranca.valor_sinal_centavos),
          referenciaExterna: cobranca.referencia_externa,
          chaveIdempotencia: cobranca.chave_idempotencia,
          emailPagador: cobranca.reserva_dados.emailPagador,
          prazoMinutos: 30
        }, cobranca.mp_environment)
      : await consultarPedidoPixComLock(pool, cobranca.mp_order_id, cobranca.mp_environment);

    conferirPedido(pedido, cobranca);

    if (emitir) {
      const intervaloPolling = Number.parseInt(process.env.PIX_POLLING_INITIAL_INTERVAL_SECONDS || "30", 10);
      const proximaConsultaEmSegundos = Number.isInteger(intervaloPolling)
        ? Math.max(15, Math.min(900, intervaloPolling))
        : 30;
      const atualizado = await pool.query(`
        UPDATE public.pix_cobrancas
        SET
          mp_order_id = $2,
          pix_polling_next_at = NOW() + ($3 * INTERVAL '1 second'),
          pix_polling_attempts = 0,
          pix_polling_lease_until = NULL,
          pix_polling_last_error = NULL,
          atualizado_em = NOW()
        WHERE id = $1
          AND estado = 'pendente'
          AND (
            mp_order_id IS NULL
            OR mp_order_id = $2
          )
        RETURNING id
      `, [cobranca.id, pedido.pedidoId, proximaConsultaEmSegundos]);

      if (atualizado.rowCount !== 1) {
        throw new Error(
          "Order recebida, mas nao conciliada no banco"
        );
      }
    }

    responder(res, 200, {
      reservaId,
      cobrancaId: cobranca.id,
      venceEm: cobranca.reserva_vence_em,
      ...pedido
    });
  } catch (erro) {
    if (erro.codigo) {
      responder(res, erro.codigo, {
        erro: erro.message
      });
      return;
    }

    console.error("[PIX Pedido] Falha:", erro.message);

    responder(res, 503, {
      erro: "Nao foi possivel emitir ou consultar o PIX. Tente novamente mais tarde."
    });
  }
}
