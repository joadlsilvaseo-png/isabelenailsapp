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

    if (
      typeof servicoId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(servicoId)
    ) {
      throw new ErroReserva(400, "Servico invalido");
    }

    // Recurso desativado durante o desenvolvimento.
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

      // Somente reservas sem cobranca podem expirar aqui.
      // Reservas com cobranca exigem conciliacao financeira.
      await conexao.query(`
        UPDATE public.pix_reservas
        SET estado = 'expirada', atualizado_em = NOW()
        WHERE data_servico = $1
          AND estado = 'reservada'
          AND vence_em <= NOW()
          AND cobranca_id IS NULL
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

      const id = randomUUID();

      const insercao = await conexao.query(`
        INSERT INTO public.pix_reservas (
          id,
          cliente_uid,
          servico_id,
          data_servico,
          inicio_minuto,
          fim_minuto,
          vence_em
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          NOW() + ($7::integer * INTERVAL '1 minute')
        )
        RETURNING id, vence_em
      `, [
        id,
        uid,
        servicoId,
        data,
        periodo.inicioMinuto,
        periodo.fimMinuto,
        minutos
      ]);

      resultado = {
        reservaId: insercao.rows[0].id,
        venceEm: insercao.rows[0].vence_em,
        servicoId,
        data,
        horario,
        duracaoMinutos: duracao,
        ...valores,
        cobrancaCriada: false
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