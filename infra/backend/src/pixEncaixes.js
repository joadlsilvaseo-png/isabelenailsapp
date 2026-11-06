import { indisponivelComBuffer } from "./agendaBuffer.mjs";
import { obterDuracaoAgendamentoPix } from "./pixDocumentoAgendamento.js";

const STATUS_OCUPADOS = new Set(["agendado", "reagendado", "confirmado"]);
const HORARIO = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Verificação obrigatória sob o advisory lock por data, antes de gravar
 * reservas PIX, isenções, reagendamentos e alterações de serviço.
 * Consulta PG + Firestore + bloqueios manuais, e falha fechada.
 */
export async function verificarEncaixeNoBanco({
  conexao, db, data, inicio, fim, excluirAgendamentoId = null, agora = new Date(),
}) {
  if (!Number.isInteger(inicio) || !Number.isInteger(fim) || inicio % 15 !== 0 || inicio >= fim) return false;
  // :15 e :45 deixam de exigir dois agendamentos vizinhos.
  // Continuamos fazendo a validação redundante no lock para proteger o PIX.
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
