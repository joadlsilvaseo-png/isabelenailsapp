import { estaNaJanelaMensal } from "./agendaJanela.js";

const ID_AGENDAMENTO = /^[A-Za-z0-9_-]{1,160}$/;

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

function dataIsoValida(data) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const [ano, mes, dia] = data.split("-").map(Number);
  const dataUtc = new Date(Date.UTC(ano, mes - 1, dia));
  return dataUtc.getUTCFullYear() === ano &&
    dataUtc.getUTCMonth() === mes - 1 &&
    dataUtc.getUTCDate() === dia;
}

async function obterFirestore() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  }
  return getFirestore();
}

async function validarAgendamentoParaExclusao(db, agendamentoId, uid) {
  const agendamento = await db.collection("agendamentos").doc(agendamentoId).get();
  if (!agendamento.exists) return { ok: false, status: 404 };
  const dados = agendamento.data();
  if (!(["agendado", "reagendado", "confirmado"].includes(dados?.status))) {
    return { ok: false, status: 409 };
  }
  if (dados.pixCobrancaId || dados.pixPagamentoId) return { ok: false, status: 409 };
  const clienteUid = dados.clienteId;
  if (typeof clienteUid !== "string" || clienteUid.length < 1 || clienteUid.length > 128) {
    return { ok: false, status: 409 };
  }
  if (clienteUid === uid) return { ok: true, clienteUid };

  const usuario = await db.collection("usuarios").doc(uid).get();
  const perfil = usuario.exists ? usuario.data() : null;
  if (perfil?.role === "admin" && perfil?.ativo === true) return { ok: true, clienteUid };
  return { ok: false, status: 403 };
}

/**
 * Read-only availability projection. It deliberately includes every reservation
 * whose PostgreSQL state still occupies the interval, even after vence_em, so a
 * pending financial reconciliation keeps the slot unavailable.
 */
export async function consultarDisponibilidadePix(req, res, pool, dependencies = {}) {
  let uid;
  try {
    const verificarUsuario = dependencies.verificarUsuario ||
      (await import("./pushSubscriptions.js")).verificarUsuario;
    uid = await verificarUsuario(req);
  } catch {
    responder(res, 401, { erro: "Não autenticado" });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const data = url.searchParams.get("data");
  const agendamentoId = url.searchParams.get("agendamentoId");
  if (!dataIsoValida(data)) {
    responder(res, 400, { erro: "Data inválida" });
    return;
  }
  if (!estaNaJanelaMensal(data, dependencies.agora || new Date())) {
    responder(res, 400, { erro: "Data fora da janela mensal de agendamento" });
    return;
  }
  if (agendamentoId !== null && !ID_AGENDAMENTO.test(agendamentoId)) {
    responder(res, 400, { erro: "Agendamento inválido" });
    return;
  }

  try {
    let clienteUidExcluido = null;
    if (agendamentoId !== null) {
      const db = dependencies.firestore || await obterFirestore();
      const acesso = await validarAgendamentoParaExclusao(db, agendamentoId, uid);
      if (!acesso.ok) {
        const mensagens = {
          403: "Agendamento não pertence à sua conta",
          404: "Agendamento não encontrado",
          409: "Este agendamento não pode ser reagendado",
        };
        responder(res, acesso.status, { erro: mensagens[acesso.status] });
        return;
      }
      clienteUidExcluido = acesso.clienteUid;
    }

    const resultado = await pool.query(`
      SELECT inicio_minuto, fim_minuto
      FROM public.pix_reservas
      WHERE data_servico = $1
        AND estado IN ('reservada', 'confirmada')
        AND ($2::text IS NULL OR agendamento_id IS DISTINCT FROM $2 OR cliente_uid IS DISTINCT FROM $3)
      ORDER BY inicio_minuto, fim_minuto
    `, [data, agendamentoId, clienteUidExcluido]);

    const intervalos = resultado.rows.map((linha) => ({
      inicioMinuto: Number(linha.inicio_minuto),
      fimMinuto: Number(linha.fim_minuto),
    }));
    if (intervalos.some(({ inicioMinuto, fimMinuto }) =>
      !Number.isInteger(inicioMinuto) || !Number.isInteger(fimMinuto) ||
      inicioMinuto < 0 || fimMinuto > 1440 || inicioMinuto >= fimMinuto)) {
      throw new Error("Intervalo de reserva inválido no banco");
    }

    responder(res, 200, { intervalos });
  } catch (erro) {
    console.error("[PIX Disponibilidade] Falha ao consultar reservas:", erro.message);
    responder(res, 503, { erro: "Não foi possível confirmar a disponibilidade" });
  }
}

