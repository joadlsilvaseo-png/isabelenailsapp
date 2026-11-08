/**
 * Preflight OPERACIONAL MANUAL, somente PG SELECT, sem eventos, tokens ou PII.
 * Nao inicia em servidor/worker. Nunca faz alteracao no banco.
 *
 * Requer GOOGLE_CALENDAR_PREFLIGHT_ENABLED=true e escrita Google desligada.
 * Os dados reais so devem ser consultados com autorizacao operacional.
 */
import pg from "pg";

const TABELAS = Object.freeze([
  "google_calendar_oauth_credentials",
  "google_calendar_event_links",
  "google_calendar_sync_operations",
  "google_calendar_reconciliation_candidates",
  "pix_calendar_outbox",
  "agendamento_cancelamentos",
  "pix_reagendamentos_pagos",
  "agendamento_alteracoes_servico",
]);

function erro(codigo) {
  return Object.assign(new Error("Preflight Calendar: " + codigo), { codigo });
}

export async function coletarPreflightCalendar(client) {
  const m = await client.query(
    `SELECT c.relname AS tabela
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND c.relname = ANY($1::text[])`,
    [TABELAS],
  );
  const presentes = new Set(m.rows.map(r => r.tabela));
  const tabela = Object.fromEntries(TABELAS.map(t => [t, presentes.has(t)]));
  const lease = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='google_calendar_sync_operations'
       AND column_name='lease_token'`,
  );
  const grupos = {};
  for (const [nome, coluna] of [
    ["pix_calendar_outbox", "status"],
    ["agendamento_cancelamentos", "calendar_estado"],
    ["pix_reagendamentos_pagos", "estado"],
    ["agendamento_alteracoes_servico", "calendar_estado"],
    ["google_calendar_sync_operations", "estado"],
    ["google_calendar_reconciliation_candidates", "situacao"],
    ["google_calendar_event_links", "situacao"],
  ]) {
    if (!presentes.has(nome)) {
      grupos[nome] = { presente: false };
      continue;
    }
    // Nome da tabela e coluna sao constantes locais, jamais dados externos.
    const q = await client.query(
      `SELECT ${coluna} AS situacao, COUNT(*)::int AS total
       FROM public.${nome} GROUP BY ${coluna} ORDER BY ${coluna}`,
    );
    grupos[nome] = Object.fromEntries(q.rows.map(r => [String(r.situacao), r.total]));
  }
  const bloqueios = [];
  if (!tabela.google_calendar_oauth_credentials) bloqueios.push("MIGRACAO_023_AUSENTE");
  if (!tabela.google_calendar_event_links ||
      !tabela.google_calendar_sync_operations ||
      !tabela.google_calendar_reconciliation_candidates) bloqueios.push("MIGRACAO_024_AUSENTE");
  if (!lease.rows.length) bloqueios.push("MIGRACAO_025_AUSENTE");
  if (!tabela.pix_calendar_outbox) bloqueios.push("OUTBOX_LEGADA_INDISPONIVEL");
  for (const estado of ["pendente", "enviando"]) {
    if ((grupos.pix_calendar_outbox?.[estado] || 0) > 0) {
      bloqueios.push("OUTBOX_LEGADA_COM_OPERACOES");
      break;
    }
  }
  if ((grupos.google_calendar_sync_operations?.aguardando_confirmacao || 0) > 0 ||
      (grupos.google_calendar_sync_operations?.conflito || 0) > 0) {
    bloqueios.push("SINCRONIZACAO_GOOGLE_INDEFINIDA");
  }
  for (const estado of ["pendente", "revisao_manual", "conflito"]) {
    if ((grupos.google_calendar_reconciliation_candidates?.[estado] || 0) > 0) {
      bloqueios.push("CANDIDATOS_A_REVISAR");
      break;
    }
  }

  return {
    somenteLeitura: true,
    tabelas: tabela,
    migracao025Instalada: lease.rows.length > 0,
    totaisPorSituacao: grupos,
    bloqueios: [...new Set(bloqueios)],
    // Mesmo que nao haja bloqueios SQL, nao aprova troca sem inventario
    // completo real, revisao humana e verificacao de todas as rotas.
    autorizadoParaMigrar: false,
    requerRevisaoHumana: true,
  };
}

async function main() {
  if (process.env.GOOGLE_CALENDAR_PREFLIGHT_ENABLED !== "true" ||
      process.env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true") {
    throw erro("OPERACAO_NAO_AUTORIZADA");
  }
  const pool = new pg.Pool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const relatorio = await coletarPreflightCalendar(client);
    await client.query("COMMIT");
    console.log(JSON.stringify(relatorio, null, 2));
  } catch(e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("/calendarCutoverPreflight.mjs")) {
  main().catch(e => {
    console.error("Preflight nao concluido: " + (e.codigo || "ERRO_VERIFICAR_AMBIENTE"));
    process.exitCode = 1;
  });
}
