import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { analisarLacunasDoDia, paraMinutos } from "./assistenteEncaixesGrade.mjs";
import { obterHojeSaoPaulo, obterMesesGerenciaveis } from "./agendamentoRegras.mjs";
import { verificarUsuario } from "./pushSubscriptions.js";

const ATIVOS = new Set(["agendado", "confirmado", "reagendado"]);
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export function firestoreAssistente() {
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  }
  return getFirestore();
}

export async function buscarAdmin(db, uid) {
  const usuario = await db.collection("usuarios").doc(uid).get();
  return usuario.exists && usuario.data()?.role === "admin" && usuario.data()?.ativo === true;
}

function mesSeguinte(mes) {
  const [ano, numero] = mes.split("-").map(Number);
  const proximo = new Date(Date.UTC(ano, numero, 1));
  return proximo.toISOString().slice(0, 7);
}

export function mesesValidos(agora = new Date()) {
  return obterMesesGerenciaveis(agora).map((item) => item.chave);
}

export async function consultarMesEncaixes({ pool, db, mes, agora = new Date() }) {
  if (!MES.test(mes)) throw new TypeError("Mês inválido");
  const primeiroDia = mes + "-01";
  const ultimoExclusivo = mesSeguinte(mes) + "-01";
  const hoje = obterHojeSaoPaulo(agora);
  const [documentos, catalogo, banco] = await Promise.all([
    db.collection("agendamentos").where("data", ">=", primeiroDia)
      .where("data", "<", ultimoExclusivo).get(),
    db.collection("servicos").get(),
    pool.query(`
      SELECT data_servico::text AS data, inicio_minuto, fim_minuto,
             'reserva'::text AS tipo, estado, agendamento_id
      FROM public.pix_reservas
      WHERE data_servico >= $1::date AND data_servico < $2::date
        AND estado IN ('reservada', 'confirmada')
      UNION ALL
      SELECT data_servico::text AS data, inicio_minuto, fim_minuto,
             'bloqueio'::text AS tipo, NULL::text AS estado, NULL::text AS agendamento_id
      FROM public.agenda_bloqueios
      WHERE data_servico >= $1::date AND data_servico < $2::date
      ORDER BY data, inicio_minuto
    `, [primeiroDia, ultimoExclusivo]),
  ]);

  const servicos = catalogo.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => item.ativo !== false)
    .map((item) => ({
      id: item.id,
      nome: String(item.nome || "").trim(),
      duracaoMinutos: Number(item.duracao ?? item.duracaoMinutos ?? item.tempo),
    }));

  const agendamentosPorDia = new Map();
  const periodosPorId = new Map();
  for (const doc of documentos.docs) {
    const item = doc.data();
    if (!ATIVOS.has(String(item.status || "").toLowerCase())) continue;
    const data = String(item.data || "");
    if (!DATA.test(data)) throw new Error("Agendamento ativo com data inválida");
    const inicioMinuto = paraMinutos(item.horario);
    const duracao = Number(item.duracao ?? 90);
    if (!Number.isInteger(duracao) || duracao <= 0 || duracao > 1440) {
      throw new Error("Agendamento ativo com duração inválida");
    }
    const lista = agendamentosPorDia.get(data) || [];
    lista.push({ inicioMinuto, fimMinuto: inicioMinuto + duracao });
    agendamentosPorDia.set(data, lista);
    periodosPorId.set(doc.id, { data, inicioMinuto, fimMinuto: inicioMinuto + duracao });
  }

  const reservasPorDia = new Map();
  const bloqueiosPorDia = new Map();
  for (const item of banco.rows) {
    const destino = item.tipo === "bloqueio" ? bloqueiosPorDia : reservasPorDia;
    // Reserva confirmada já representada pelo agendamento do Firestore.
    const correspondente = periodosPorId.get(item.agendamento_id);
    // Só deduplicar se Firestore e PostgreSQL concordarem sobre data E período.
    // Reagendamentos PIX em andamento podem manter uma reserva antiga.
    if (item.tipo === "reserva" && item.estado === "confirmada" &&
        correspondente?.data === item.data &&
        correspondente.inicioMinuto === Number(item.inicio_minuto) &&
        correspondente.fimMinuto === Number(item.fim_minuto)) continue;
    const dados = {
      inicioMinuto: Number(item.inicio_minuto),
      fimMinuto: Number(item.fim_minuto),
    };
    const lista = destino.get(item.data) || [];
    lista.push(dados);
    destino.set(item.data, lista);
  }

  const oportunidades = [];
  for (let dia = primeiroDia; dia < ultimoExclusivo; ) {
    if (dia >= hoje) {
      oportunidades.push(...analisarLacunasDoDia({
        data: dia,
        agendamentos: agendamentosPorDia.get(dia) || [],
        reservas: reservasPorDia.get(dia) || [],
        bloqueios: bloqueiosPorDia.get(dia) || [],
        servicos, hoje, agora,
      }));
    }
    const seguinte = new Date(Date.parse(dia + "T12:00:00Z") + 86400000);
    dia = seguinte.toISOString().slice(0, 10);
  }
  return oportunidades;
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

export async function atenderAssistenteEncaixes(req, res, pool, dependencies = {}) {
  let uid;
  try { uid = await (dependencies.verificarUsuario || verificarUsuario)(req); }
  catch { responder(res, 401, { erro: "Faça login para acessar o assistente." }); return; }

  try {
    const db = dependencies.db || firestoreAssistente();
    if (!(await buscarAdmin(db, uid))) {
      responder(res, 403, { erro: "Acesso exclusivo da administração." });
      return;
    }
    if (req.method !== "GET") {
      responder(res, 405, { erro: "Somente consulta é permitida." });
      return;
    }
    const agora = dependencies.agora || new Date();
    const url = new URL(req.url, "http://localhost");
    const mes = url.searchParams.get("mes") || obterHojeSaoPaulo(agora).slice(0, 7);
    const data = url.searchParams.get("data");
    if (!mesesValidos(agora).includes(mes) || (data && (!DATA.test(data) || !data.startsWith(mes)))) {
      responder(res, 400, { erro: "Período fora da janela administrativa." });
      return;
    }
    const todas = await (dependencies.consultarMes || consultarMesEncaixes)({
      pool, db, mes, agora,
    });
    const oportunidades = data ? todas.filter((item) => item.data === data) : todas;
    responder(res, 200, {
      mes, data: data || null, oportunidades, total: oportunidades.length,
      consultadoEm: agora.toISOString(),
      aviso: "Encaixes excepcionais são sugestões, nunca reservas. Confira a agenda antes de combinar.",
    });
  } catch (erro) {
    console.error("[AssistenteEncaixes] Consulta indisponível:", erro.message);
    responder(res, 503, { erro: "Não foi possível analisar a agenda. Tente novamente." });
  }
}
