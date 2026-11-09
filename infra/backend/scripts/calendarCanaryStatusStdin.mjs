/**
 * Diagnostico SOMENTE LEITURA do evento ficticio do canario.
 * Nao invoca DELETE, PATCH, INSERT ou tabelas de agendamentos.
 * Nunca imprime nomes, IDs reais, credenciais nem texto do evento.
 */
import pg from "pg";
import { criarAdaptadorGoogleCalendarComOAuth } from "/app/src/googleCalendarTokenProvider.js";
import { gerarIdEventoGoogle } from "/app/src/googleCalendarEvents.js";

const ID = "calendar-canary-isabele-20261109";
const EVENTO_ID = gerarIdEventoGoogle(ID);
if (process.env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true" ||
    process.env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED === "true" ||
    process.env.GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED === "true" ||
    process.env.GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED === "true") {
  console.error("DIAGNOSTICO_BLOQUEADO");
  process.exit(2);
}
const pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 10000 });
let resultado;
try {
  const client = criarAdaptadorGoogleCalendarComOAuth(pool);
  const ev = await client.consultarEvento({ eventId: EVENTO_ID });
  const apagado = ev === null || ev.status === "cancelled";
  const propriedade = ev?.extendedProperties?.private;
  resultado = {
    modo: "SOMENTE_LEITURA",
    eventoTemporario: ev === null ? "AUSENTE_404" :
      ev.status === "cancelled" ? "EXCLUIDO_CANCELLED" :
      ev.status === "confirmed" ? "AINDA_ATIVO" : "STATUS_INESPERADO",
    excluidoConfirmado: apagado,
    ...(ev && !apagado ? {
      tituloTesteCorresponde: ev.summary === "TESTE TEMPORARIO API - SEM CLIENTE",
      propriedadeTesteCorresponde:
        propriedade?.isabeleAgendamentoId === ID &&
        propriedade?.isabeleOrigem === "isabele-vps",
    } : {}),
    operacoesDeEscrita: 0,
  };
} catch (e) {
  resultado = { modo: "SOMENTE_LEITURA", resultado: "FALHA_CONSULTA",
    codigo: e.codigo || "INDEFINIDO", operacoesDeEscrita: 0 };
  process.exitCode = 1;
} finally {
  await pool.end();
}
console.log(JSON.stringify(resultado, null, 2));
