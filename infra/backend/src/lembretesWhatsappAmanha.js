/** Consulta e confirmacao MANUAL de lembretes pelo WhatsApp Business.
 * Nao chama WhatsApp, nao envia mensagens e nao altera agendamentos/PIX.
 */
import { amanhaSaoPaulo, normalizarLembrete, resumoLembretes, validarMarcacao } from "./lembretesWhatsappAmanhaCore.mjs";

const LIMITE_AGENDAMENTOS = 250;
const LIMITE_BODY = 2048;

function falha(status, mensagem) {
  return Object.assign(new Error(mensagem), { status });
}
function responder(res, status, corpo) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(corpo));
}
async function firestorePadrao() {
  const { applicationDefault, getApps, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({
    credential: applicationDefault(), projectId: "isabele-nails-app",
  });
  return getFirestore();
}
async function lerJson(req) {
  let corpo = "";
  for await (const parte of req) {
    corpo += parte.toString("utf8");
    if (Buffer.byteLength(corpo, "utf8") > LIMITE_BODY) {
      throw falha(413, "Requisição muito grande.");
    }
  }
  try {
    const dados = JSON.parse(corpo);
    if (!validarMarcacao(dados)) throw new Error("Inválido");
    return dados;
  } catch {
    throw falha(400, "Dados de lembrete inválidos.");
  }
}

async function buscarLembretesAtuais(db, data) {
  // Pesquisa por ambos os nomes de campo para nao omitir agendamentos legados.
  const [modernos, legados] = await Promise.all([
    db.collection("agendamentos").where("data", "==", data).get(),
    db.collection("agendamentos").where("dataAgendamento", "==", data).get(),
  ]);
  const documentos = new Map();
  for (const snapshot of [modernos, legados]) {
    for (const doc of snapshot.docs) documentos.set(doc.id, doc.data() || {});
  }
  if (documentos.size > LIMITE_AGENDAMENTOS) {
    throw falha(503, "Muitos agendamentos para processar. Tente novamente.");
  }

  const ids = new Set();
  for (const agendamento of documentos.values()) {
    const uid = String(agendamento.clienteId || agendamento.idCliente ||
      agendamento.uidCliente || agendamento.userId || agendamento.usuarioId || "").trim();
    if (/^[A-Za-z0-9_-]{1,128}$/.test(uid)) ids.add(uid);
  }
  const perfis = new Map(await Promise.all([...ids].map(async (uid) => {
    const snap = await db.collection("clientes").doc(uid).get();
    return [uid, snap.exists ? snap.data() : {}];
  })));

  const itens = [];
  for (const [id, agendamento] of documentos) {
    const uid = String(agendamento.clienteId || agendamento.idCliente ||
      agendamento.uidCliente || agendamento.userId || agendamento.usuarioId || "").trim();
    const item = normalizarLembrete({
      id, agendamento, cliente: perfis.get(uid) || {}, data,
    });
    if (item) itens.push(item);
  }
  itens.sort((a, b) => a.horario.localeCompare(b.horario) ||
    a.nome.localeCompare(b.nome, "pt-BR") || a.agendamentoId.localeCompare(b.agendamentoId));
  return itens;
}

export async function listarLembretesAmanha({ db, pool, agora = new Date() }) {
  const data = amanhaSaoPaulo(agora);
  const itens = await buscarLembretesAtuais(db, data);
  if (itens.length) {
    const registros = await pool.query(
      "SELECT agendamento_id, assinatura, marcado_em " +
      "FROM public.lembretes_whatsapp_manuais " +
      "WHERE data_servico=$1::date AND agendamento_id = ANY($2::text[])",
      [data, itens.map((item) => item.agendamentoId)],
    );
    const marcados = new Map(registros.rows.map((r) => [
      r.agendamento_id + ":" + r.assinatura, r.marcado_em,
    ]));
    for (const item of itens) {
      const marcadoEm = marcados.get(item.agendamentoId + ":" + item.assinatura);
      item.marcadoEnviado = Boolean(marcadoEm);
      item.marcadoEm = marcadoEm || null;
    }
  }
  for (const item of itens) {
    if (item.marcadoEnviado === undefined) item.marcadoEnviado = false;
    if (item.marcadoEm === undefined) item.marcadoEm = null;
  }
  return { data, resumo: resumoLembretes(itens), itens };
}

export async function atualizarMarcacaoLembrete({ db, pool, agora = new Date(), adminUid, dados, marcar }) {
  if (!validarMarcacao(dados)) throw falha(400, "Dados de lembrete inválidos.");
  const data = amanhaSaoPaulo(agora);
  // Revalidar ANTES da gravacao: remarcacoes, cancelamentos e mudancas
  // de servico/telefone tornam a assinatura anterior obsoleta.
  const agendamentoSnap = await db.collection("agendamentos").doc(dados.agendamentoId).get();
  if (!agendamentoSnap.exists) throw falha(409, "Agendamento não está mais disponível.");
  const agendamento = agendamentoSnap.data() || {};
  const uid = String(agendamento.clienteId || agendamento.idCliente ||
    agendamento.uidCliente || agendamento.userId || agendamento.usuarioId || "").trim();
  const clienteSnap = /^[A-Za-z0-9_-]{1,128}$/.test(uid)
    ? await db.collection("clientes").doc(uid).get() : null;
  const item = normalizarLembrete({
    id: dados.agendamentoId, agendamento, data,
    cliente: clienteSnap?.exists ? clienteSnap.data() : {},
  });
  if (!item || item.assinatura !== dados.assinatura) {
    throw falha(409, "O agendamento foi alterado. Atualize os lembretes.");
  }
  if (!item.possuiTelefone) {
    throw falha(409, "A cliente não possui telefone válido para WhatsApp.");
  }
  if (marcar) {
    await pool.query(
      "INSERT INTO public.lembretes_whatsapp_manuais " +
      "(agendamento_id, assinatura, data_servico, marcado_por_uid) " +
      "VALUES ($1, $2, $3::date, $4) ON CONFLICT (agendamento_id, assinatura) DO NOTHING",
      [item.agendamentoId, item.assinatura, data, adminUid],
    );
  } else {
    await pool.query(
      "DELETE FROM public.lembretes_whatsapp_manuais " +
      "WHERE agendamento_id=$1 AND assinatura=$2 AND data_servico=$3::date",
      [item.agendamentoId, item.assinatura, data],
    );
  }
  return { ok: true, marcadoEnviado: marcar };
}

export async function atenderLembretesWhatsappAmanha(req, res, pool, dependencies = {}) {
  let uid;
  try {
    const verificar = dependencies.verificarUsuario ||
      (await import("./pushSubscriptions.js")).verificarUsuario;
    uid = await verificar(req);
  } catch {
    responder(res, 401, { erro: "Não autenticado." });
    return;
  }
  try {
    const db = dependencies.firestore || await firestorePadrao();
    const admin = await db.collection("usuarios").doc(uid).get();
    if (admin.data()?.role !== "admin" || admin.data()?.ativo !== true) {
      responder(res, 403, { erro: "Acesso administrativo negado." });
      return;
    }
    const path = new URL(req.url, "http://localhost").pathname;
    const agora = dependencies.now || new Date();
    if (path === "/admin/lembretes-amanha" && req.method === "GET") {
      responder(res, 200, await listarLembretesAmanha({ db, pool, agora }));
      return;
    }
    if (path === "/admin/lembretes-amanha/marcacao" &&
      (req.method === "POST" || req.method === "DELETE")) {
      const dados = await lerJson(req);
      responder(res, 200, await atualizarMarcacaoLembrete({
        db, pool, agora, adminUid: uid, dados, marcar: req.method === "POST",
      }));
      return;
    }
    responder(res, 405, { erro: "Operação não permitida." });
  } catch (erro) {
    if (erro.status) {
      responder(res, erro.status, { erro: erro.message });
      return;
    }
    console.error("[Lembretes WhatsApp] Falha técnica:", erro.message);
    responder(res, 503, { erro: "Não foi possível consultar os lembretes. Tente novamente." });
  }
}
