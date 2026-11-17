import { validarDataNaJanela } from "./agendamentoRegras.mjs";
import { verificarUsuario } from "./pushSubscriptions.js";

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
 * Consulta agrupada SOMENTE para sugestoes de novas reservas (ate sete dias).
 * Mantem a mesma semantica da rota diaria, sem alterar estados financeiros.
 * Se faltar qualquer data ou intervalo for invalido, falha fechada.
 */
async function consultarDisponibilidadePeriodo(url, res, pool, uid, dependencies) {
  const valores = url.searchParams.get("datas")?.split(",") || [];
  const agora = dependencies.now || new Date();
  const datasValidas = valores.length >= 1 && valores.length <= 7 &&
    new Set(valores).size === valores.length &&
    valores.every((data) => dataIsoValida(data) && validarDataNaJanela(data, agora).valido) &&
    valores.every((data, indice) => indice === 0 || data > valores[indice - 1]) &&
    Date.parse(valores.at(-1)) - Date.parse(valores[0]) <= 6 * 86400000;
  if (!datasValidas || url.searchParams.getAll("datas").length !== 1 ||
      url.searchParams.has("data") || url.searchParams.has("agendamentoId")) {
    responder(res, 400, { erro: "Período inválido" });
    return;
  }

  try {
    // Uma unica consulta SQL, incluindo PIX reservado/confirmado e bloqueios.
    const resultado = await pool.query(`
      SELECT to_char(data_servico, 'YYYY-MM-DD') AS data,
             inicio_minuto, fim_minuto, 'reserva'::text AS tipo,
             (estado = 'confirmada' AND cliente_uid = $2::text
               AND agendamento_id IS NOT NULL) AS sequencial_mesma_cliente
      FROM public.pix_reservas
      WHERE data_servico = ANY($1::date[])
        AND estado IN ('reservada', 'confirmada')
      UNION ALL
      SELECT to_char(data_servico, 'YYYY-MM-DD') AS data,
             inicio_minuto, fim_minuto, 'bloqueio'::text AS tipo,
             FALSE AS sequencial_mesma_cliente
      FROM public.agenda_bloqueios
      WHERE data_servico = ANY($1::date[])
      ORDER BY data, inicio_minuto, fim_minuto
    `, [valores, uid]);

    const intervalosPorData = Object.fromEntries(valores.map((data) => [data, []]));
    for (const linha of resultado.rows) {
      const inicioMinuto = Number(linha.inicio_minuto);
      const fimMinuto = Number(linha.fim_minuto);
      if (!Object.hasOwn(intervalosPorData, linha.data) ||
          !Number.isInteger(inicioMinuto) || !Number.isInteger(fimMinuto) ||
          inicioMinuto < 0 || fimMinuto > 1440 || inicioMinuto >= fimMinuto ||
          !["reserva", "bloqueio"].includes(linha.tipo)) {
        throw new Error("Intervalo agrupado inválido");
      }
      intervalosPorData[linha.data].push({
        inicioMinuto, fimMinuto, tipo: linha.tipo,
        ...(linha.sequencial_mesma_cliente === true ? { sequencialMesmaCliente: true } : {}),
      });
    }
    responder(res, 200, { intervalosPorData });
  } catch (erro) {
    console.error("[PIX Disponibilidade] Falha na consulta agrupada:", erro.message);
    responder(res, 503, { erro: "Não foi possível confirmar a disponibilidade" });
  }
}

/**
 * Read-only availability projection. It deliberately includes every reservation
 * whose PostgreSQL state still occupies the interval, even after vence_em, so a
 * pending financial reconciliation keeps the slot unavailable.
 */
export async function consultarDisponibilidadePix(req, res, pool, dependencies = {}) {
  let uid;
  try {
    uid = await (dependencies.verificarUsuario || verificarUsuario)(req);
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
  const janelaValida = validarDataNaJanela(data, dependencies.now || new Date());
  if (!janelaValida.valido) {
    responder(res, 400, { erro: janelaValida.motivo });
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

    // Bloqueios administrativos continuam valendo inclusive no reagendamento.
    const resultado = await pool.query(`
      SELECT inicio_minuto, fim_minuto, 'reserva'::text AS tipo,
             (estado = 'confirmada'
               AND cliente_uid = COALESCE($3::text, $4::text)
               AND agendamento_id IS NOT NULL) AS sequencial_mesma_cliente
      FROM public.pix_reservas
      WHERE data_servico = $1
        AND estado IN ('reservada', 'confirmada')
        AND ($2::text IS NULL OR agendamento_id IS DISTINCT FROM $2 OR cliente_uid IS DISTINCT FROM $3)
      UNION ALL
      SELECT inicio_minuto, fim_minuto, 'bloqueio'::text AS tipo,
             FALSE AS sequencial_mesma_cliente
      FROM public.agenda_bloqueios
      WHERE data_servico = $1
      ORDER BY inicio_minuto, fim_minuto
    `, [data, agendamentoId, clienteUidExcluido, uid]);

    const intervalos = resultado.rows.map((linha) => ({
      inicioMinuto: Number(linha.inicio_minuto),
      fimMinuto: Number(linha.fim_minuto),
      tipo: linha.tipo === "bloqueio" ? "bloqueio" : "reserva",
      ...(linha.sequencial_mesma_cliente === true ? { sequencialMesmaCliente: true } : {}),
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

