/**
 * Operador MANUAL para inventario apenas leitura. NAO roda no startup.
 *
 * Uso futuro (depois de aplicar migração 024, em janela autorizada):
 * GOOGLE_CALENDAR_AUDIT_ENABLED=true node scripts/calendarReadOnlyReport.mjs 2026-12-01 2026-12-08
 *
 * A unica escrita opcional e o arquivo de relatorio LOCAL e privado, nunca
 * no PostgreSQL, Firebase ou Google Calendar. Nao imprime nomes nem tokens.
 */
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { criarAdaptadorGoogleCalendarComOAuth } from "../src/googleCalendarTokenProvider.js";
import { levantarConciliacaoCalendar } from "../src/googleCalendarInventarioReadOnly.js";

const ROOT = "/root/.config/isabele-google-oauth/reports";
async function main() {
  const [inicio, fim, opcao] = process.argv.slice(2);
  if (!inicio || !fim || process.argv.length > 5 ||
      (opcao && !/^--report=[a-zA-Z0-9_-]{1,60}\.json$/.test(opcao))) {
    throw new Error("Uso: node scripts/calendarReadOnlyReport.mjs AAAA-MM-DD AAAA-MM-DD [--report=nome.json]");
  }
  if (process.env.GOOGLE_CALENDAR_AUDIT_ENABLED !== "true" ||
      process.env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true") {
    throw new Error("Auditoria read-only nao autorizada.");
  }
  const calendarId = String(process.env.GOOGLE_CALENDAR_ID || "");
  if (!calendarId) throw new Error("Calendario nao configurado.");

  if (!getApps().length) {
    initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  }
  const pool = new pg.Pool();
  try {
    const adaptador = criarAdaptadorGoogleCalendarComOAuth(pool);
    const relatorio = await levantarConciliacaoCalendar({
      pool, firestore: getFirestore(), adaptador, calendarId, inicio, fim,
    });
    if (opcao) {
      await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
      const destino = path.join(ROOT, opcao.slice("--report=".length));
      const fd = await fs.open(destino, "wx", 0o600);
      try {
        await fd.writeFile(JSON.stringify(relatorio, null, 2) + "\n", "utf8");
      } finally {
        await fd.close();
      }
      console.log("Relatorio privado salvo no diretorio de auditoria.");
    }
    console.log(JSON.stringify({
      somenteLeitura: true, janela: relatorio.intervalo,
      fontes: relatorio.fontes, resumo: relatorio.resumo,
      // O operador deve abrir o arquivo privado para examinar os IDs.
      registrosDetalhadosExibidos: false,
    }, null, 2));
  } finally {
    await pool.end();
  }
}
main().catch(e => {
  // Nao revelar stack/erro da biblioteca HTTP ou conexao (pode conter PII).
  console.error("Falha no inventario: " + (e.codigo || "VERIFICAR_AMBIENTE"));
  process.exitCode = 1;
});
