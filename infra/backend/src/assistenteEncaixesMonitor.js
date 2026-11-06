import { createHash } from "node:crypto";
import { consultarProximosSeteDias, firestoreAssistente } from "./assistenteEncaixes.js";
import { criarNotificacaoPreventiva } from "./assistenteEncaixesNotificacao.mjs";

const CHAVE_ESTADO = "assistente_agenda_preventivo_snapshot_v1";
const INTERVALO_MS = 180000;
let programado = null;
let executando = false;
let ativo = false;

const identidade = (item) => item.chave;

export function descreverNovasOportunidades(anteriores, oportunidades) {
  if (!Array.isArray(anteriores) || !Array.isArray(oportunidades)) throw new TypeError("Estado do assistente inválido");
  const conhecidas = new Set(anteriores);
  return oportunidades.filter((op) => !conhecidas.has(identidade(op)));
}

function chaveEntrega(data, uid, itens) {
  const fingerprint = createHash("sha256").update(itens.map(identidade).sort().join("\n")).digest("hex").slice(0, 24);
  return `assistente-agenda-v1:${data}:${uid}:${fingerprint}`;
}

/** Varredura de leitura; não altera reservas nem agendamentos. */
export async function varrerOportunidades({ pool, db, agora = new Date(), consultar = consultarProximosSeteDias }) {
  const atuais = [...new Map((await consultar({ pool, db, agora })).map((op) => [identidade(op), op])).values()];
  const atuaisIds = atuais.map(identidade).sort();
  const con = await pool.connect();
  try {
    await con.query("BEGIN");
    await con.query("SELECT pg_advisory_xact_lock(hashtext('isabele_assistente_agenda_preventivo'), 1)");
    const anterior = await con.query("SELECT valor FROM public.push_controle WHERE chave = $1 FOR UPDATE", [CHAVE_ESTADO]);
    if (!anterior.rowCount) {
      await con.query("INSERT INTO public.push_controle (chave, valor) VALUES ($1, $2)", [CHAVE_ESTADO, JSON.stringify({ chaves: atuaisIds })]);
      await con.query("UPDATE public.push_entregas SET estado = 'cancelado' WHERE tipo = 'oportunidade_encaixe' AND estado = 'pendente'");
      await con.query("COMMIT");
      return { inicializado: true, novas: 0, total: atuais.length };
    }

    const salvo = JSON.parse(anterior.rows[0].valor);
    const antigas = Array.isArray(salvo?.chaves) ? salvo.chaves : [];
    const novas = descreverNovasOportunidades(antigas, atuais);
    const identidadesAtuais = new Set(atuaisIds);
    const diasAlterados = new Set(novas.map((item) => item.data));
    for (const chave of antigas) {
      if (!identidadesAtuais.has(chave)) diasAlterados.add(chave.slice(0, 10));
    }
    const dbAtual = await db.collection("usuarios").where("role", "==", "admin").get();
    const destinatarios = dbAtual.docs.filter((doc) => doc.data()?.ativo === true).map((doc) => doc.id);
    const porDia = new Map();
    for (const item of atuais.filter((item) => diasAlterados.has(item.data))) {
      const lista = porDia.get(item.data) || [];
      lista.push(item);
      porDia.set(item.data, lista);
    }
    const chavesEntregaAtuais = [];
    const atuaisPorDia = new Map();
    for (const item of atuais) {
      const lista = atuaisPorDia.get(item.data) || [];
      lista.push(item);
      atuaisPorDia.set(item.data, lista);
    }
    for (const [data, itens] of atuaisPorDia) {
      for (const uid of destinatarios) chavesEntregaAtuais.push(chaveEntrega(data, uid, itens));
    }
    for (const [data, itens] of porDia) {
      const resumo = criarNotificacaoPreventiva(data, itens);
      for (const uid of destinatarios) {
        const chave = chaveEntrega(data, uid, atuais.filter((op) => op.data === data));
        await con.query(`
          INSERT INTO public.push_entregas (
            chave_evento, agendamento_id, destinatario_uid, tipo, titulo, mensagem, destino
          ) VALUES ($1, $2, $3, 'sugestao_bloqueio_agenda', $4, $5, $6)
          ON CONFLICT (chave_evento) DO NOTHING
        `, [chave, `assistente_${data}`, uid, resumo.titulo, resumo.mensagem, `./admin-calendario.html?data=${data}`]);
      }
    }

    await con.query(`
      UPDATE public.push_entregas
      SET estado = 'cancelado'
      WHERE tipo = 'sugestao_bloqueio_agenda' AND estado = 'pendente'
        AND NOT (chave_evento = ANY($1::text[]))
    `, [chavesEntregaAtuais]);
    await con.query("UPDATE public.push_controle SET valor = $2, atualizado_em = NOW() WHERE chave = $1", [CHAVE_ESTADO, JSON.stringify({ chaves: atuaisIds })]);
    await con.query("COMMIT");
    return { inicializado: false, novas: novas.length, total: atuais.length };
  } catch (erro) {
    await con.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    con.release();
  }
}

async function executar(pool, db) {
  if (executando || !ativo) return;
  executando = true;
  try {
    const resultado = await varrerOportunidades({ pool, db });
    if (resultado.novas) console.log("[Assistente] Sugestões preventivas novas:", resultado.novas);
  } catch (erro) {
    console.error("[Assistente] Falha na varredura:", erro.message);
  } finally { executando = false; }
}

export function sinalizarMudancaNaAgenda() {
  if (!ativo || programado) return;
  programado = setTimeout(() => {
    programado = null;
    if (monitorPool && monitorDb) void executar(monitorPool, monitorDb);
  }, 6000);
}

let monitorPool = null;
let monitorDb = null;

export function iniciarMonitorOportunidades(pool) {
  if (process.env.ASSISTENTE_ENCAIXES_NOTIFICACOES_ENABLED !== "true") {
    console.log("[Assistente] Notificações automáticas desativadas por configuração.");
    return;
  }
  monitorPool = pool;
  monitorDb = firestoreAssistente();
  ativo = true;
  void executar(pool, monitorDb);
  setInterval(() => void executar(pool, monitorDb), INTERVALO_MS);
  console.log("[Assistente] Monitor preventivo iniciado.");
}
