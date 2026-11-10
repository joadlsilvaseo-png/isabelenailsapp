/**
 * Inventario de referencia cruzada, so com operacoes de leitura:
 * Firestore agendamentos, PostgreSQL outbox/vinculos e Google events.list.
 *
 * O modulo e inerte ao importar. Nao cria rota, job, transacao de escrita
 * ou tabela. Falha se os limites ou a listagem remota nao forem completos.
 */
import { conciliarEventosGoogle } from "./googleCalendarReconciliacao.js";

function erro(codigo) {
  return Object.assign(new Error("Inventario Calendar: " + codigo), { codigo });
}
function validarDia(valor) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw erro("DATA_INVALIDA");
  const d = new Date(valor + "T12:00:00Z");
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== valor) throw erro("DATA_INVALIDA");
  return valor;
}

export async function levantarConciliacaoCalendar({
  pool, firestore, adaptador, calendarId, inicio, fim, env = process.env,
} = {}) {
  if (env.GOOGLE_CALENDAR_AUDIT_ENABLED !== "true" ||
      env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true") {
    throw erro("AUDITORIA_DESATIVADA");
  }
  if (typeof pool?.query !== "function" ||
      typeof firestore?.collection !== "function" ||
      typeof adaptador?.listarEventos !== "function" ||
      typeof calendarId !== "string" || !calendarId.trim()) {
    throw erro("DEPENDENCIAS_INVALIDAS");
  }
  const de = validarDia(inicio), ate = validarDia(fim); // fim EXCLUSIVO
  const dtDe = new Date(de + "T00:00:00Z").getTime(), dtAte = new Date(ate + "T00:00:00Z").getTime();
  if (dtAte <= dtDe || dtAte - dtDe > 30 * 86400000) throw erro("PERIODO_INVALIDO");

  // Buscar por fonte: nao ha JOIN entre contas de diferentes sistemas.
  const [snapshot, outboxResult, remoto] = await Promise.all([
    firestore.collection("agendamentos")
      .where("data", ">=", de).where("data", "<", ate).limit(4001).get(),
    pool.query(
      `SELECT agendamento_id, event_id FROM public.pix_calendar_outbox
       WHERE data_servico >= $1::date AND data_servico < $2::date
       ORDER BY data_servico, agendamento_id LIMIT 4001`,
      [de, ate],
    ),
    adaptador.listarEventos({
      inicio: de + "T00:00:00-03:00", fim: ate + "T00:00:00-03:00",
    }),
  ]);
  const docs = snapshot?.docs;
  if (!Array.isArray(docs) || docs.length > 4000 ||
      !Array.isArray(outboxResult?.rows) || outboxResult.rows.length > 4000 ||
      remoto?.completo !== true || !Array.isArray(remoto?.eventos)) {
    throw erro("INVENTARIO_INCOMPLETO");
  }

  const agendamentos = docs.map(doc => ({
    id: doc.id,
    calendarEventId: doc.data()?.calendarEventId || null,
  }));

  // Vinculos de OUTROS meses nao podem aparecer como "evento ausente":
  // o intervalo solicitado e propositalmente limitado a ate 30 dias.
  const idsNaJanela = new Set([
    ...agendamentos.map(a => a.id),
    ...outboxResult.rows.map(o => o.agendamento_id),
    ...remoto.eventos.map(e => e.extendedProperties?.private?.isabeleAgendamentoId)
      .filter(Boolean),
  ]);
  // Consultar SOMENTE vinculos relevantes para esta janela.
  // Fazer SELECT global LIMIT 4001 descartava meses recentes quando a tabela
  // possuia historico suficiente: erro perigoso por falso "vinculo ausente".
  const listaIds = [...idsNaJanela].filter(id => typeof id === "string");
  if (listaIds.length > 4000) throw erro("INVENTARIO_INCOMPLETO");
  const linksResult = listaIds.length
    ? await pool.query(
      `SELECT agendamento_id, google_event_id, origem
       FROM public.google_calendar_event_links
       WHERE calendar_id = $1 AND agendamento_id = ANY($2::text[])
       ORDER BY agendamento_id LIMIT 4001`, [calendarId, listaIds],
    )
    : { rows: [] };
  if (!Array.isArray(linksResult?.rows) || linksResult.rows.length > 4000) {
    throw erro("INVENTARIO_INCOMPLETO");
  }
  const vinculosDaJanela = linksResult.rows.filter(v => idsNaJanela.has(v.agendamento_id));
  const relatorio = conciliarEventosGoogle({
    agendamentos,
    outbox: outboxResult.rows,
    vinculos: vinculosDaJanela,
    eventos: remoto.eventos,
  });
  return {
    ...relatorio,
    intervalo: { inicio: de, fimExclusivo: ate },
    fontes: { firestore: docs.length, pixOutbox: outboxResult.rows.length,
      vinculosConfirmados: vinculosDaJanela.length, paginasGoogle: remoto.paginas },
    nenhumaAlteracaoRealizada: true,
  };
}
