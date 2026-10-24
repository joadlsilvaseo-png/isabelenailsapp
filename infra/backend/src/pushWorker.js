import webpush from "web-push";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  agendamentoAtivo,
  extrairAgendamento,
  instanteAgendamentoSaoPaulo,
} from "./agendaLembretes.js";

// ======================================================
// CONFIGURAÇÃO DO WEB PUSH
// ======================================================

const HOSTS_PERMITIDOS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "web.push.apple.com",
]);
const PROJECT_ID = "isabele-nails-app";
const TIPOS_LEMBRETE = new Set(["lembrete_24h", "lembrete_1h"]);

let processamentoAtivo = false;

function endpointPermitido(endpoint) {
  try {
    const url = new URL(endpoint);

    const hostname = url.hostname.toLowerCase();

    const hostValido =
      HOSTS_PERMITIDOS.has(hostname) ||
      hostname === "notify.windows.com" ||
      hostname.endsWith(".notify.windows.com");

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      hostValido
    );
  } catch {
    return false;
  }
}

// ======================================================
// ENVIAR NOTIFICAÇÃO AOS DISPOSITIVOS DO DESTINATÁRIO
// ======================================================

async function enviarNotificacao(entrega, pool, inicioAgendamento = null) {
  const consulta = await pool.query(
    `
    SELECT id, endpoint, p256dh, auth
    FROM public.push_subscriptions
    WHERE firebase_uid = $1
    ORDER BY atualizado_em DESC
    LIMIT 5
    `,
    [entrega.destinatario_uid],
  );

  if (consulta.rows.length === 0) {
    return "sem_dispositivo";
  }

  const payload = JSON.stringify({
    title: entrega.titulo,
    body: entrega.mensagem,
    url: entrega.destino,
    tag: TIPOS_LEMBRETE.has(entrega.tipo)
      ? `agendamento-${entrega.agendamento_id}-${entrega.tipo}`
      : `agendamento-${entrega.agendamento_id}`,
  });

  let ttl = 3600;
  if (inicioAgendamento) {
    ttl = Math.min(
      24 * 60 * 60,
      Math.floor((inicioAgendamento.getTime() - Date.now()) / 1000) - 5,
    );
    if (ttl <= 0) return "expirada";
  }

  let enviados = 0;
  let falhasTemporarias = 0;

  for (const dispositivo of consulta.rows) {
    if (!endpointPermitido(dispositivo.endpoint)) {
      console.warn("[PushWorker] Endpoint não permitido:", dispositivo.id);

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
      await webpush.sendNotification(subscription, payload, {
        TTL: ttl,
        timeout: 10000,
        urgency: "normal",
      });

      enviados++;
    } catch (erro) {
      const codigo = erro.statusCode;

      console.error("[PushWorker] Falha no envio:", codigo || erro.message);

      if (codigo === 404 || codigo === 410) {
        await pool.query(
          `
          DELETE FROM public.push_subscriptions
          WHERE id = $1
          AND firebase_uid = $2
          `,
          [dispositivo.id, entrega.destinatario_uid],
        );
      } else {
        falhasTemporarias++;
      }
    }
  }

  if (enviados > 0) {
    return "enviado";
  }

  if (falhasTemporarias > 0) {
    throw new Error("Falha temporária no serviço Push.");
  }

  return "sem_dispositivo";
}

async function obterFirestore() {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  }
  return getFirestore();
}

/** Revalida o snapshot PostgreSQL e o documento Firestore imediatamente antes do Push. */
export async function validarLembreteAgendamento(
  pool,
  entrega,
  firestore,
  agora = new Date(),
) {
  if (!TIPOS_LEMBRETE.has(entrega?.tipo)) return null;

  const estado = await pool.query(
    `
    SELECT agendamento_id, cliente_id, status, data_agendamento,
           horario, servico, versao
    FROM public.push_agendamento_estado
    WHERE agendamento_id = $1
      AND cliente_id = $2
      AND versao = $3
    `,
    [entrega.agendamento_id, entrega.destinatario_uid, Number(entrega.agendamento_versao)],
  );
  const salvo = estado.rows[0];
  if (!salvo || !agendamentoAtivo(salvo)) return null;

  const db = firestore || await obterFirestore();
  const documento = await db.collection("agendamentos").doc(entrega.agendamento_id).get();
  if (!documento.exists) return null;

  const atual = extrairAgendamento(documento.data(), documento.id);
  if (
    !agendamentoAtivo(atual) ||
    atual.clienteId !== entrega.destinatario_uid ||
    atual.status !== String(salvo.status).toLowerCase() ||
    atual.data !== String(salvo.data_agendamento || "") ||
    atual.horario !== String(salvo.horario || "").slice(0, 5) ||
    atual.servico !== String(salvo.servico || "")
  ) {
    return null;
  }

  const inicio = instanteAgendamentoSaoPaulo(atual.data, atual.horario);
  if (!inicio || inicio.getTime() <= new Date(agora).getTime()) return null;
  return { inicio };
}

// ======================================================
// FINALIZAR ENTREGA
// ======================================================

async function finalizarEntrega(pool, id, estado) {
  await pool.query(
    `
    UPDATE public.push_entregas
    SET
      estado = $2,
      reservado_em = NULL,
      enviado_em = CASE
        WHEN $2 = 'enviado' THEN NOW()
        ELSE enviado_em
      END
    WHERE id = $1
    `,
    [id, estado],
  );
}

// ======================================================
// REAGENDAR ENTREGA QUE FALHOU
// ======================================================

async function reagendarEntrega(pool, entrega) {
  if (entrega.tentativas >= 5) {
    await finalizarEntrega(pool, entrega.id, "erro");

    console.error("[PushWorker] Limite de tentativas:", entrega.id);

    return;
  }

  const segundos = Math.min(3600, 30 * Math.pow(2, entrega.tentativas - 1));

  await pool.query(
    `
    UPDATE public.push_entregas
    SET
      estado = 'pendente',
      reservado_em = NULL,
      proxima_tentativa =
        NOW() + ($2::integer * INTERVAL '1 second')
    WHERE id = $1
    `,
    [entrega.id, segundos],
  );
}

// ======================================================
// RESERVAR NOTIFICAÇÕES PENDENTES
// ======================================================

async function reservarEntregas(pool) {
  const resultado = await pool.query(
    `
    WITH selecionadas AS (
      SELECT id
      FROM public.push_entregas
      WHERE (
        estado = 'pendente'
        AND proxima_tentativa <= NOW()
      )
      OR (
        estado = 'processando'
        AND reservado_em < NOW() - INTERVAL '5 minutes'
      )
      ORDER BY id
      LIMIT 5
      FOR UPDATE SKIP LOCKED
    )

    UPDATE public.push_entregas AS entrega
    SET
      estado = 'processando',
      reservado_em = NOW(),
      tentativas = entrega.tentativas + 1
    FROM selecionadas
    WHERE entrega.id = selecionadas.id
    RETURNING entrega.*
    `,
  );

  return resultado.rows;
}

// ======================================================
// PROCESSAR FILA
// ======================================================

async function processarFila(pool) {
  if (processamentoAtivo) {
    return;
  }

  processamentoAtivo = true;

  try {
    const entregas = await reservarEntregas(pool);

    for (const entrega of entregas) {
      try {
        const resultado = await processarEntrega(pool, entrega);

        console.log("[PushWorker] Entrega processada:", entrega.id, resultado);
      } catch (erro) {
        console.error("[PushWorker] Erro:", entrega.id, erro.message);

        await reagendarEntrega(pool, entrega);
      }
    }
  } finally {
    processamentoAtivo = false;
  }
}

export async function processarEntrega(pool, entrega, dependencias = {}) {
  let validacao = null;
  if (TIPOS_LEMBRETE.has(entrega.tipo)) {
    validacao = await (dependencias.validar || validarLembreteAgendamento)(
      pool,
      entrega,
      dependencias.firestore,
      dependencias.agora || new Date(),
    );
    if (!validacao) {
      await finalizarEntrega(pool, entrega.id, "cancelado");
      return "cancelado";
    }
  }

  const enviar = dependencias.enviar || enviarNotificacao;
  const resultado = await enviar(entrega, pool, validacao?.inicio || null);
  await finalizarEntrega(pool, entrega.id, resultado);
  return resultado;
}

// ======================================================
// INICIAR WORKER
// ======================================================

export function iniciarWorkerPush(pool) {
  if (process.env.PUSH_WORKER_ENABLED !== "true") {
    console.log("[PushWorker] Worker desativado.");
    return;
  }

  webpush.setVapidDetails(
    "https://github.com/joadlsilvaseo-png/isabelenailsapp",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  console.log("[PushWorker] Worker iniciado.");

  const executar = () => {
    processarFila(pool).catch((erro) => {
      console.error("[PushWorker] Falha na fila:", erro);
    });
  };

  executar();

  setInterval(executar, 10000);
}
