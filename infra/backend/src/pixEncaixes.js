import { indisponivelComBuffer } from "./agendaBuffer.mjs";
import { obterDuracaoAgendamentoPix } from "./pixDocumentoAgendamento.js";
import { validarHorarioPix } from "./pixDisponibilidade.js";

const STATUS_OCUPADOS = new Set(["agendado", "reagendado", "confirmado"]);
const HORARIO = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Revalidação sob advisory lock por data dos inícios :15/:45.
 * Na grade nativa de 15 minutos NÃO exigimos um atendimento anterior
 * e posterior como âncoras: basta respeitar buffer, ocupação e bloqueios.
 * Consulta PG + Firestore + bloqueios manuais, e falha fechada.
 */
export async function verificarEncaixeNoBanco({
  conexao, db, data, inicio, fim, excluirAgendamentoId = null, agora = new Date(),
}) {
  if (inicio % 30 !== 15) return true;
  if (!db || !conexao || typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return false;
  const [resultado, documentos] = await Promise.all([
    conexao.query(`
      SELECT inicio_minuto, fim_minuto, 'reserva'::text AS tipo
      FROM public.pix_reservas
      WHERE data_servico = $1 AND estado IN ('reservada', 'confirmada')
        AND ($2::text IS NULL OR agendamento_id IS DISTINCT FROM $2)
      UNION ALL
      SELECT inicio_minuto, fim_minuto, 'bloqueio'::text AS tipo
      FROM public.agenda_bloqueios WHERE data_servico = $1
    `, [data, excluirAgendamentoId]),
    db.collection("agendamentos").where("data", "==", data).get(),
  ]);
  const intervalos = resultado.rows.map((item) => ({
    inicioMinuto: Number(item.inicio_minuto),
    fimMinuto: Number(item.fim_minuto),
    tipo: item.tipo === "bloqueio" ? "bloqueio" : "reserva",
  }));
  for (const doc of documentos.docs) {
    if (doc.id === excluirAgendamentoId) continue;
    const item = doc.data();
    if (!STATUS_OCUPADOS.has(item.status)) continue;
    if (typeof item.horario !== "string" || !HORARIO.test(item.horario)) {
      throw new Error("Agendamento ativo com horário inválido");
    }
    const [h, mm] = item.horario.split(":").map(Number);
    const comeco = h * 60 + mm;
    intervalos.push({
      inicioMinuto: comeco,
      fimMinuto: comeco + obterDuracaoAgendamentoPix(item.duracao),
      tipo: "agendamento",
    });
  }
  return !indisponivelComBuffer(inicio, fim, intervalos);
}
