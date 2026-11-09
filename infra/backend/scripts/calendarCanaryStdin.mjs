/**
 * Canary isolado da escrita Google Calendar.
 *
 * Executar somente via node --input-type=module - --run (stdin), com
 * GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=true e
 * GOOGLE_CALENDAR_CANARY_APPROVED=true apenas no processo docker exec.
 *
 * Cria, consulta, altera e exclui UM evento temporario inteiramente
 * sintetico de janeiro de 2035. Nao consulta, cria ou altera agendamentos
 * reais; nao altera PostgreSQL (exceto SELECT OAuth), Firebase ou PIX.
 * Em falha tenta excluir apenas seu proprio evento com marcadores exatos.
 *
 * Nunca usar esse script para migracao de reservas reais.
 */
import pg from "pg";
import { criarAdaptadorGoogleCalendarComOAuth } from "/app/src/googleCalendarTokenProvider.js";
import { gerarIdEventoGoogle } from "/app/src/googleCalendarEvents.js";

const ID = "calendar-canary-isabele-20261109";
const SERVICO = "TESTE TEMPORARIO API";
const NOME = "SEM CLIENTE";
const SUMMARY = SERVICO + " - " + NOME;
const INICIO = "2035-01-15T08:00:00-03:00";
const FIM = "2035-01-15T09:00:00-03:00";
const NOVO_INICIO = "2035-01-15T09:00:00-03:00";
const NOVO_FIM = "2035-01-15T10:00:00-03:00";
const EVENTO_ID = gerarIdEventoGoogle(ID);

function fail(code) {
  throw Object.assign(new Error(code), { codigo: code });
}
function confirmarCanario(e) {
  return e?.id === EVENTO_ID &&
    e.summary === SUMMARY &&
    e.extendedProperties?.private?.isabeleAgendamentoId === ID &&
    e.extendedProperties?.private?.isabeleOrigem === "isabele-vps" &&
    !e.attendees?.length;
}
const env = process.env;
if (env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true" ||
    env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED !== "true" ||
    env.GOOGLE_CALENDAR_CANARY_APPROVED !== "true" ||
    env.GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED === "true" ||
    env.GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED === "true" ||
    env.GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED === "true" ||
    process.argv.slice(2).length !== 1 ||
    !["--run", "--cleanup"].includes(process.argv[2])) {
  console.error("CANARIO_BLOQUEADO: FLAG_OU_MODO_INVALIDO");
  process.exit(2);
}

let pool;
let client;
let written = false;
let clean = false;
let problem = null;
const steps = [];
try {
  pool = new pg.Pool({ max: 1, connectionTimeoutMillis: 10000 });
  client = criarAdaptadorGoogleCalendarComOAuth(pool, { env });

  let existent = await client.consultarEvento({ eventId: EVENTO_ID });
  if (existent) {
    if (!confirmarCanario(existent)) fail("EVENTO_ID_OCUPADO_POR_OUTRO_EVENTO");
    await client.excluirEvento({ agendamentoId: ID, eventId: EVENTO_ID });
    existent = await client.consultarEvento({ eventId: EVENTO_ID });
    if (existent !== null) fail("CANARIO_ANTERIOR_NAO_REMOVIDO");
    steps.push("RESIDUO_ANTERIOR_REMOVIDO");
  }
  if (process.argv[2] === "--cleanup") {
    clean = true;
    steps.push("LIMPEZA_CONCLUIDA");
  } else {
    const create = await client.criarEvento({
      agendamentoId: ID, nomeCliente: NOME, servico: SERVICO,
      inicio: INICIO, fim: FIM,
    });
    if (create.eventId !== EVENTO_ID) fail("ID_NAO_CONFIRMADO");
    written = true;
    const created = await client.consultarEvento({ eventId: EVENTO_ID });
    if (!confirmarCanario(created) ||
        Date.parse(created.start?.dateTime) !== Date.parse(INICIO) ||
        Date.parse(created.end?.dateTime) !== Date.parse(FIM)) {
      fail("CRIACAO_NAO_CONFIRMADA");
    }
    steps.push("CREATE_GET_OK");

    await client.atualizarEvento({
      agendamentoId: ID, eventId: EVENTO_ID,
      nomeCliente: NOME, servico: SERVICO,
      inicio: NOVO_INICIO, fim: NOVO_FIM,
    });
    const updated = await client.consultarEvento({ eventId: EVENTO_ID });
    if (!confirmarCanario(updated) ||
        Date.parse(updated.start?.dateTime) !== Date.parse(NOVO_INICIO) ||
        Date.parse(updated.end?.dateTime) !== Date.parse(NOVO_FIM)) {
      fail("ATUALIZACAO_NAO_CONFIRMADA");
    }
    steps.push("PATCH_GET_ETAG_OK");

    await client.excluirEvento({ agendamentoId: ID, eventId: EVENTO_ID });
    const deleted = await client.consultarEvento({ eventId: EVENTO_ID });
    if (deleted !== null) fail("EXCLUSAO_NAO_CONFIRMADA");
    clean = true;
    steps.push("DELETE_GET_OK");
  }
} catch (e) {
  problem = e.codigo || "FALHA_SEM_DETALHES";
} finally {
  // Tentar limpar mesmo quando POST/PATCH/DELETE apresentou timeout.
  // NUNCA deletar um evento sem marcador privado e titulo identicos.
  if (!clean && client) {
    try {
      const check = await client.consultarEvento({ eventId: EVENTO_ID });
      if (check === null) {
        clean = true;
      } else if (confirmarCanario(check)) {
        await client.excluirEvento({ agendamentoId: ID, eventId: EVENTO_ID });
        clean = (await client.consultarEvento({ eventId: EVENTO_ID })) === null;
      } else {
        problem = "CANARIO_COLLISION";
      }
    } catch {
      // Verificacao de limpeza inconclusiva; operador deve executar --cleanup.
    }
  }
  if (pool) await pool.end().catch(() => {});
}
console.log(JSON.stringify({
  resultado: problem ? "CANARIO_FALHOU" : "CANARIO_GOOGLE_API_CONCLUIDO",
  operacoes: steps,
  houveCriacao: written,
  eventoTemporarioRemovido: clean,
  bancoAgendamentosModificado: false,
  observacao: clean ? "Nenhum evento de teste pendente." :
    "Executar --cleanup antes de outro teste; nao mexer em atendimentos reais.",
  ...(problem ? { codigo: problem } : {}),
}, null, 2));
if (problem || !clean) process.exitCode = 1;
