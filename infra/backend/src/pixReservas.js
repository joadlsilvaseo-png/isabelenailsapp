import { randomUUID } from "node:crypto";
import {
  initializeApp,
  applicationDefault,
  getApps
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { verificarUsuario } from "./pushSubscriptions.js";
import { validarHorarioPix } from "./pixDisponibilidade.js";
import { verificarConflitoFirestore } from "./pixAgendaFirestore.js";
import {
  ambienteMercadoPagoAtual,
  consultarPedidoPix,
  mercadoPagoHabilitado
} from "./pixMercadoPago.js";
import { validarRetornoPagamentoPix } from "./pixValidacaoPagamento.js";
import {
  encerrarCobrancaPixSemPagamento,
  registrarCreditoPix
} from "./pixConciliacao.js";
import { efetivarAgendamentoPix } from "./pixEfetivacao.js";

class ErroReserva extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(dados));
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > 4096) {
      throw new ErroReserva(413, "Requisicao muito grande");
    }

    partes.push(parte);
  }

  try {
    const dados = JSON.parse(
      Buffer.concat(partes).toString("utf8")
    );

    if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
      throw new Error("Objeto invalido");
    }

    return dados;
  } catch {
    throw new ErroReserva(400, "JSON invalido");
  }
}

function firestore() {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: "isabele-nails-app"
    });
  }
  return getFirestore();
}

function validarDataFutura(data, horario) {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const valores = Object.fromEntries(
    partes.map((item) => [item.type, item.value])
  );

  const agora = [
    valores.year,
    valores.month,
    valores.day
  ].join("-") + "T" + valores.hour + ":" + valores.minute;

  if (`${data}T${horario}` <= agora) {
    throw new ErroReserva(409, "Horario ja passou");
  }
}

function calcularValores(preco, regra) {
  if (
    typeof preco !== "number" ||
    !Number.isFinite(preco) ||
    preco <= 0
  ) {
    throw new ErroReserva(422, "Preco do servico invalido");
  }

  const valorTotal = Math.round(preco * 100);

  if (
    !Number.isSafeInteger(valorTotal) ||
    Math.abs(preco * 100 - valorTotal) > 1e-7
  ) {
    throw new ErroReserva(422, "Preco do servico invalido");
  }

  let valorSinal;

  if (regra.tipo_sinal_padrao === "fixo") {
    valorSinal = Number(regra.valor_fixo_padrao_centavos);
  } else if (regra.tipo_sinal_padrao === "percentual") {
    const percentual = Number(regra.percentual_padrao);
    const pontos = Math.round(percentual * 100);

    if (
      !Number.isFinite(percentual) ||
      pontos <= 0 ||
      pontos > 10000
    ) {
      throw new ErroReserva(422, "Percentual invalido");
    }

    valorSinal = Math.round(valorTotal * pontos / 10000);
  } else {
    throw new ErroReserva(422, "Tipo de sinal invalido");
  }

  if (
    !Number.isSafeInteger(valorSinal) ||
    valorSinal <= 0 ||
    valorSinal > valorTotal
  ) {
    throw new ErroReserva(
      422,
      "Sinal invalido para o valor do servico"
    );
  }

  return {
    valorTotalCentavos: valorTotal,
    valorSinalCentavos: valorSinal,
    valorRestanteCentavos: valorTotal - valorSinal
  };
}

async function reconciliarReservasVencidasDoDia(pool, data) {
  const consulta = await pool.query(`
    SELECT
      c.id,
      c.cliente_uid,
      c.mp_order_id,
      c.referencia_externa,
      c.valor_sinal_centavos,
      c.mp_environment,
      r.id AS reserva_id
    FROM public.pix_reservas r
    JOIN public.pix_cobrancas c ON c.id = r.cobranca_id
    WHERE r.data_servico = $1
      AND r.estado = 'reservada'
      AND r.vence_em <= NOW()
      AND c.estado = 'pendente'
      AND c.mp_order_id IS NOT NULL
    ORDER BY r.vence_em
    LIMIT 10
  `, [data]);

  await Promise.allSettled(consulta.rows.map(async (cobranca) => {
    try {
      const ambiente = cobranca.mp_environment || "test";
      if (!mercadoPagoHabilitado(ambiente)) return;
      const pedido = await consultarPedidoPix(cobranca.mp_order_id, ambiente);
      const validacao = validarRetornoPagamentoPix(pedido, cobranca);

      if (validacao.creditado) {
        const credito = await registrarCreditoPix({
          pool,
          cobrancaId: cobranca.id,
          uid: cobranca.cliente_uid,
          pedido
        });

        // O ID estavel permite recuperar um documento ja criado antes
        // de uma falha entre Firestore e PostgreSQL. Reserva vencida
        // sem documento novo nunca e convertida em agendamento.
        try {
          await efetivarAgendamentoPix({
            pool,
            cobrancaId: cobranca.id,
            uid: cobranca.cliente_uid
          });
        } catch (erro) {
          if (!erro?.requerAnalise) throw erro;
          await pool.query(`
            UPDATE public.pix_reservas
            SET estado = 'expirada', atualizado_em = NOW()
            WHERE id = $1
              AND estado = 'reservada'
              AND vence_em <= NOW()
          `, [cobranca.reserva_id]);
        }
        return credito;
      }

      if (["expirada", "cancelada"].includes(validacao.situacao)) {
        await encerrarCobrancaPixSemPagamento({
          pool,
          cobrancaId: cobranca.id,
          uid: cobranca.cliente_uid,
          situacao: validacao.situacao
        });
      }
    } catch (erro) {
      // Se Mercado Pago estiver indisponivel, mantemos o bloqueio.
      // Liberar sem confirmar o estado externo poderia duplicar horarios.
      console.warn("[PIX Reserva] Nao foi possivel reconciliar pedido vencido:", erro.message);
    }
  }));
}

export async function criarReservaPix(req, res, pool) {
  let uid;

  try {
    uid = await verificarUsuario(req);
  } catch {
    responder(res, 401, { erro: "Nao autenticado" });
    return;
  }

  try {
    const dados = await lerJson(req);
    const { servicoId, data, horario } = dados;
    const nomeCliente =
      typeof dados.nomeCliente === "string"
        ? dados.nomeCliente.trim().slice(0, 120)
        : "";

    if (!nomeCliente) {
      throw new ErroReserva(400, "Nome da cliente invalido");
    }

    if (
      typeof servicoId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(servicoId)
    ) {
      throw new ErroReserva(400, "Servico invalido");
    }

    const ambienteMP = ambienteMercadoPagoAtual();
    if (!mercadoPagoHabilitado(ambienteMP)) {
      throw new ErroReserva(409, `PIX desativado para ${ambienteMP}`);
    }

    const habilitacao = await pool.query(
      "SELECT ativo FROM public.pix_configuracao WHERE id = 1"
    );

    if (habilitacao.rows[0]?.ativo !== true) {
      throw new ErroReserva(409, "PIX ainda nao habilitado");
    }

    const servicoSnap = await firestore()
      .collection("servicos")
      .doc(servicoId)
      .get();

    if (
      !servicoSnap.exists ||
      servicoSnap.data()?.ativo === false
    ) {
      throw new ErroReserva(404, "Servico indisponivel");
    }

    const servico = servicoSnap.data();
    const duracao = Number(servico.duracao);

    const periodo = validarHorarioPix(data, horario, duracao);

    if (!periodo.valido) {
      throw new ErroReserva(400, periodo.motivo);
    }

    validarDataFutura(data, horario);

    await reconciliarReservasVencidasDoDia(pool, data);

    const conexao = await pool.connect();
    let resultado;

    try {
      await conexao.query("BEGIN");

      // Uma criacao de reserva por vez para cada data.
      await conexao.query(
        "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
        [data]
      );

      const config = await conexao.query(`
        SELECT
          ativo,
          tipo_sinal_padrao,
          valor_fixo_padrao_centavos,
          percentual_padrao,
          reserva_minutos
        FROM public.pix_configuracao
        WHERE id = 1
        FOR SHARE
      `);

      const regra = config.rows[0];

      if (!regra?.ativo) {
        throw new ErroReserva(409, "PIX desativado");
      }

      const minutos = Number(regra.reserva_minutos);

      if (
        !Number.isInteger(minutos) ||
        minutos < 30 ||
        minutos > 60
      ) {
        throw new ErroReserva(
          503,
          "Prazo da reserva PIX precisa ser configurado"
        );
      }

      const valores = calcularValores(servico.preco, regra);

      // Libera somente reservas sem pedido enviado ao MP.
      // Antes de chamar a API externa, a cobranca devera
      // mudar para pendente e exigir conciliacao.
      await conexao.query(`
        UPDATE public.pix_reservas AS r
        SET estado = 'expirada', atualizado_em = NOW()
        WHERE r.data_servico = $1
          AND r.estado = 'reservada'
          AND r.vence_em <= NOW()
          AND (
            r.cobranca_id IS NULL
            OR EXISTS (
              SELECT 1
              FROM public.pix_cobrancas AS c
              WHERE c.id = r.cobranca_id
                AND c.estado = 'criada'
                AND c.mp_order_id IS NULL
            )
          )
      `, [data]);

      const conflito = await verificarConflitoFirestore(
        data,
        periodo.inicioMinuto,
        periodo.fimMinuto
      );

      if (conflito.ocupado) {
        throw new ErroReserva(
          409,
          "Horario ocupado por outro agendamento"
        );
      }

      const reservaId = randomUUID();
      const cobrancaId = randomUUID();
      const chaveIdempotencia = randomUUID();

      const referenciaExterna =
        `isabele_pix_${cobrancaId.replaceAll("-", "")}`;

      const vencimento = await conexao.query(
        "SELECT NOW() + ($1::integer * INTERVAL '1 minute') AS vence_em",
        [minutos]
      );

      const venceEm = vencimento.rows[0].vence_em;

      const percentual =
        regra.tipo_sinal_padrao === "percentual"
          ? Number(regra.percentual_padrao)
          : null;

      const valorFixo =
        regra.tipo_sinal_padrao === "fixo"
          ? Number(regra.valor_fixo_padrao_centavos)
          : null;

      const reservaDados = {
        servicoId,
        nomeServico: servico.nome || "Servico",
        nomeCliente,
        data,
        horario,
        duracaoMinutos: duracao
      };

      // Registra primeiro a cobranca e a chave de idempotencia.
      await conexao.query(`
        INSERT INTO public.pix_cobrancas (
          id,
          cliente_uid,
          reserva_dados,
          referencia_externa,
          chave_idempotencia,
          valor_total_centavos,
          percentual_sinal,
          valor_sinal_centavos,
          valor_restante_centavos,
          mp_environment,
          estado,
          vence_em,
          tipo_sinal,
          valor_fixo_configurado_centavos
        )
        VALUES (
          $1, $2, $3::jsonb, $4, $5,
          $6, $7, $8, $9, $10,
          'criada', $11, $12, $13
        )
      `, [
        cobrancaId,
        uid,
        JSON.stringify(reservaDados),
        referenciaExterna,
        chaveIdempotencia,
        valores.valorTotalCentavos,
        percentual,
        valores.valorSinalCentavos,
        valores.valorRestanteCentavos,
        ambienteMP,
        venceEm,
        regra.tipo_sinal_padrao,
        valorFixo
      ]);

      // Vincula o horario a cobranca na mesma transacao.
      await conexao.query(`
        INSERT INTO public.pix_reservas (
          id,
          cliente_uid,
          servico_id,
          data_servico,
          inicio_minuto,
          fim_minuto,
          vence_em,
          cobranca_id
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
      `, [
        reservaId,
        uid,
        servicoId,
        data,
        periodo.inicioMinuto,
        periodo.fimMinuto,
        venceEm,
        cobrancaId
      ]);

      resultado = {
        reservaId,
        cobrancaId,
        venceEm,
        servicoId,
        data,
        horario,
        duracaoMinutos: duracao,
        ...valores,
        cobrancaPreparada: true,
        cobrancaCriada: false,
        pedidoMercadoPagoCriado: false
      };

      await conexao.query("COMMIT");
    } catch (erro) {
      await conexao.query("ROLLBACK").catch(() => {});
      throw erro;
    } finally {
      conexao.release();
    }

    responder(res, 201, resultado);
  } catch (erro) {
    if (erro.code === "23P01") {
      responder(res, 409, {
        erro: "Horario reservado por outra cliente"
      });
      return;
    }

    if (erro instanceof ErroReserva) {
      responder(res, erro.status, { erro: erro.message });
      return;
    }

    console.error("[PIX Reserva]", erro.message);

    responder(res, 500, {
      erro: "Falha ao reservar horario"
    });
  }
}
