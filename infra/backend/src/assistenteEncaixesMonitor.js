import { randomUUID } from "node:crypto";
import { consultarMesEncaixes, firestoreAssistente, mesesValidos } from "./assistenteEncaixes.js";

const CHAVE_ESTADO = "assistente_encaixes_snapshot_v1";
const INTERVALO_MS = 180000; // fallback para alterações PG e reconciliações
let programado = null;
let executando = false;
let ativo = false;

export function descreverNovasOportunidades(anteriores, oportunidades) {
  if (!Array.isArray(anteriores) || !Array.isArray(oportunidades)) {
    throw new TypeError("Estado do assistente inválido");
  }
  const conhecidas = new Set(anteriores);
  return oportunidades.filter((op) => !conhecidas.has(op.chave));
}

/** Releitura somente de leitura; nenhuma escrita em reservas ou agendamentos. */
export async function varrerOportunidades({ pool, db, agora = new Date(), consultar = consultarMesEncaixes }) {
  const meses = mesesValidos(agora);
  const oportunidades = (await Promise.all(
    meses.map((mes) => consultar({ pool, db, mes, agora })),
  )).flat();
  const atuais = [...new Map(oportunidades.map((op) => [op.chave, op])).values()];
  const chavesAtuais = atuais.map((item) => item.chave).sort();
  const con = await pool.connect();
  try {
    await con.query("BEGIN");
    // Apenas uma instância notifica a mesma mudança.
    await con.query("SELECT pg_advisory_xact_lock(hashtext('isabele_assistente_encaixes'), 1)");
    const anterior = await con.query(
      "SELECT valor FROM public.push_controle WHERE chave = $1 FOR UPDATE", [CHAVE_ESTADO],
    );
    if (!anterior.rowCount) {
      // O primeiro ciclo apenas estabelece referência; não notificar todo o histórico.
      await con.query(
        "INSERT INTO public.push_controle (chave, valor) VALUES ($1, $2)",
        [CHAVE_ESTADO, JSON.stringify({ meses, chaves: chavesAtuais })],
      );
      await con.query("COMMIT");
      return { inicializado: true, novas: 0, total: atuais.length };
    }

    const estadoSalvo = JSON.parse(anterior.rows[0].valor);
    const antigas = Array.isArray(estadoSalvo) ? estadoSalvo : estadoSalvo.chaves;
    const mesesAnteriores = new Set(Array.isArray(estadoSalvo)
      ? antigas.map((chave) => chave.slice(0, 7))
      : estadoSalvo.meses);
    // Não anunciar lacunas antigas de um mês recém-incluído na janela.
    const novas = descreverNovasOportunidades(antigas, atuais)
      .filter((item) => mesesAnteriores.has(item.data.slice(0, 7)));
    if (novas.length) {
      const administradores = await db.collection("usuarios").where("role", "==", "admin").get();
      const destinatarios = administradores.docs
        .filter((doc) => doc.data()?.ativo === true).map((doc) => doc.id);
      if (!destinatarios.length) throw new Error("Nenhuma administradora ativa para avisos");
      // Um aviso por dia evita dezenas de pushes de uma só vez.
      const porDia = new Map();
      for (const op of novas) {
        const itens = porDia.get(op.data) || [];
        itens.push(op);
        porDia.set(op.data, itens);
      }
      for (const [data, itens] of porDia) {
        const [ano, mes, dia] = data.split("-");
        const primeira = itens[0];
        const titulo = itens.length === 1 ? "Nova oportunidade de encaixe" : "Novas oportunidades de encaixe";
        const mensagem = itens.length === 1
          ? `Isabele, surgiu um intervalo de ${primeira.duracaoLacunaMinutos} minutos em ${dia}/${mes}, das ${primeira.inicio} às ${primeira.fim}. Veja os serviços que podem ser encaixados.`
          : `Isabele, surgiram ${itens.length} oportunidades em ${dia}/${mes}/${ano}. Consulte o Assistente de Agenda.`;
        for (const uid of destinatarios) {
          await con.query(`
            INSERT INTO public.push_entregas (
              chave_evento, agendamento_id, destinatario_uid, tipo,
              titulo, mensagem, destino
            ) VALUES ($1, $2, $3, 'oportunidade_encaixe', $4, $5, './admin-assistente.html')
            ON CONFLICT (chave_evento) DO NOTHING
          `, [
            `assistente:${randomUUID()}:${uid}`, `assistente_${data}`, uid, titulo, mensagem,
          ]);
        }
      }
    }

    await con.query(
      "UPDATE public.push_controle SET valor = $2, atualizado_em = NOW() WHERE chave = $1",
      [CHAVE_ESTADO, JSON.stringify({ meses, chaves: chavesAtuais })],
    );
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
    if (resultado.novas) console.log("[Assistente] Oportunidades novas:", resultado.novas);
  } catch (erro) {
    console.error("[Assistente] Falha na varredura:", erro.message);
  } finally {
    executando = false;
  }
}

/** Chamado após uma mudança Firestore; agrupa eventos para não varrer por documento. */
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
  console.log("[Assistente] Monitor de encaixes iniciado.");
}
