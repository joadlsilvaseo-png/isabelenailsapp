/**
 * Registro transacional da futura transicao Calendar.
 *
 * INERTE: sem rotas, sem workers, sem chamadas Google e sem deploy.
 * Escrever nesta outbox exige GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED=true.
 * Registrar na fila NAO executa um evento; o worker e o cutover real nao
 * existem nesta fase. Os eventos legados NAO podem ser editados aqui.
 */
import { createHash, randomUUID } from "node:crypto";
import { gerarIdEventoGoogle } from "./googleCalendarEvents.js";

const TIPOS = new Set(["criar", "reagendar", "cancelar", "alterar_servico"]);
const ATIVOS = ["pendente", "processando", "aguardando_confirmacao", "conflito"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{5,1024}$/;
const CHAVE = /^[A-Za-z0-9_-]{16,160}$/;

function erro(codigo) {
  return Object.assign(new Error("Operacao Calendar bloqueada: " + codigo), { codigo });
}
function validar(valor, regex, codigo) {
  if (typeof valor !== "string" || !regex.test(valor)) throw erro(codigo);
  return valor;
}
function serializar(valor) {
  if (valor === undefined) throw erro("PEDIDO_INVALIDO");
  if (valor === null || typeof valor === "string" || typeof valor === "boolean" ||
      (typeof valor === "number" && Number.isFinite(valor))) {
    return JSON.stringify(valor);
  }
  if (Array.isArray(valor)) return "[" + valor.map(serializar).join(",") + "]";
  if (!valor || Object.getPrototypeOf(valor) !== Object.prototype ||
      Object.keys(valor).length > 50) throw erro("PEDIDO_INVALIDO");
  const chaves = Object.keys(valor).sort();
  if (chaves.some(x => ["__proto__", "constructor", "prototype"].includes(x))) {
    throw erro("PEDIDO_INVALIDO");
  }
  return "{" + chaves.map(x => JSON.stringify(x) + ":" + serializar(valor[x])).join(",") + "}";
}
export function fingerprintIntencaoCalendar(pedido) {
  if (!pedido || Array.isArray(pedido) || typeof pedido !== "object") throw erro("PEDIDO_INVALIDO");
  const texto = serializar(pedido);
  if (texto.length > 16000) throw erro("PEDIDO_EXCESSIVO");
  return createHash("sha256").update(texto).digest("hex");
}
function somenteFila(env) {
  if (env.GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED !== "true") {
    throw erro("FILA_DESATIVADA");
  }
}
function somenteWorker(env) {
  somenteFila(env);
  if (env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED !== "true" ||
      env.GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED !== "true") {
    throw erro("WORKER_DESATIVADO");
  }
}
async function transacao(pool, callback) {
  if (typeof pool?.connect !== "function") throw erro("BANCO_INDISPONIVEL");
  const conexao = await pool.connect();
  let iniciada = false;
  try {
    await conexao.query("BEGIN");
    iniciada = true;
    const resultado = await callback(conexao);
    await conexao.query("COMMIT");
    return resultado;
  } catch (e) {
    if (iniciada) await conexao.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    conexao.release();
  }
}

function confirmarOperacao(row, pedido) {
  if (row.agendamento_id !== pedido.agendamentoId ||
      row.calendar_id !== pedido.calendarId ||
      row.tipo !== pedido.tipo ||
      row.google_event_id !== pedido.googleEventId ||
      row.fingerprint_pedido !== pedido.fingerprint) {
    throw erro("CHAVE_IDEMPOTENCIA_DIVERGENTE");
  }
}

/**
 * Apenas cria uma INTENCAO duravel. Nao inicia Google nem muda PIX.
 * Nao aceita novos eventos quando ja existe vinculo confirmado ou legado
 * candidato a revisao para o mesmo agendamento.
 */
export async function registrarIntencaoCalendar(pool, {
  chaveIdempotencia, agendamentoId, calendarId, tipo, googleEventId, pedido,
}, { env = process.env } = {}) {
  somenteFila(env);
  const chave = validar(chaveIdempotencia, CHAVE, "CHAVE_INVALIDA");
  const id = validar(agendamentoId, ID, "AGENDAMENTO_INVALIDO");
  const calendar = validar(calendarId, /^\S{1,300}$/, "CALENDARIO_INVALIDO");
  if (!TIPOS.has(tipo)) throw erro("TIPO_INVALIDO");
  const eventId = tipo === "criar"
    ? gerarIdEventoGoogle(id)
    : validar(googleEventId, EVENT_ID, "EVENTO_INVALIDO");
  if (tipo === "criar" && googleEventId !== undefined && googleEventId !== eventId) {
    throw erro("EVENTO_NAO_DETERMINISTICO");
  }
  const fingerprint = fingerprintIntencaoCalendar({
    agendamentoId: id, calendarId: calendar, tipo, eventId, pedido,
  });
  const esperado = { agendamentoId: id, calendarId: calendar, tipo,
    googleEventId: eventId, fingerprint };

  return transacao(pool, async conexao => {
    const original = await conexao.query(
      `SELECT operation_id, agendamento_id, calendar_id, tipo, google_event_id,
              fingerprint_pedido, estado
       FROM public.google_calendar_sync_operations
       WHERE chave_idempotencia = $1 FOR UPDATE`, [chave],
    );
    if (original.rows.length) {
      confirmarOperacao(original.rows[0], esperado);
      return { operationId: original.rows[0].operation_id, estado: original.rows[0].estado,
        jaRegistrada: true };
    }

    // Serializa decisao por agendamento, mesmo na primeira intencao, em que
    // ainda nao existe vinculo. Advisory lock transacional funciona entre
    // containers da mesma base. Unique constraints sao defesa adicional.
    await conexao.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      [id],
    );
    // Segunda leitura apos o advisory lock: chamadas simultaneas com a
    // mesma chave devem devolver a operacao criada pela primeira transacao.
    const depoisDoLock = await conexao.query(
      `SELECT operation_id, agendamento_id, calendar_id, tipo, google_event_id,
              fingerprint_pedido, estado
       FROM public.google_calendar_sync_operations
       WHERE chave_idempotencia = $1 FOR UPDATE`, [chave],
    );
    if (depoisDoLock.rows.length) {
      confirmarOperacao(depoisDoLock.rows[0], esperado);
      return { operationId: depoisDoLock.rows[0].operation_id,
        estado: depoisDoLock.rows[0].estado, jaRegistrada: true };
    }
    const antigo = await conexao.query(
      `SELECT google_event_id, calendar_id, origem, situacao
       FROM public.google_calendar_event_links
       WHERE agendamento_id = $1 FOR UPDATE`, [id],
    );
    const vinculo = antigo.rows[0];
    const ativa = await conexao.query(
      `SELECT operation_id FROM public.google_calendar_sync_operations
       WHERE agendamento_id = $1 AND estado = ANY($2::text[])
       LIMIT 1 FOR UPDATE`, [id, ATIVOS],
    );
    if (ativa.rows.length) throw erro("OUTRA_OPERACAO_PENDENTE");
    if (tipo === "criar") {
      if (vinculo) throw erro("AGENDAMENTO_JA_VINCULADO");
      const pendencias = await conexao.query(
        `SELECT 1 FROM public.google_calendar_reconciliation_candidates
         WHERE agendamento_id = $1 AND situacao <> 'rejeitado' LIMIT 1`,
        [id],
      );
      if (pendencias.rows.length) throw erro("LEGADO_AGUARDANDO_RECONCILIACAO");
      // Ausencia de candidatos NAO comprova que uma reserva e nova!
      // Um fluxo futuro deve autorizar expressamente reservas nascidas
      // APOS o corte validado; nunca fazer backfill automatico.
      const liberacao = await conexao.query(
        `SELECT calendar_id, autorizacao, consumido_em
         FROM public.google_calendar_creation_authorizations
         WHERE agendamento_id = $1 FOR UPDATE`, [id],
      );
      const autorizado = liberacao.rows[0];
      if (!autorizado || autorizado.calendar_id !== calendar ||
          autorizado.autorizacao !== "nova_reserva_verificada" ||
          autorizado.consumido_em !== null) {
        throw erro("CRIACAO_NAO_AUTORIZADA");
      }
    } else if (!vinculo || vinculo.google_event_id !== eventId ||
               vinculo.calendar_id !== calendar || vinculo.situacao !== "ativo") {
      throw erro("EVENTO_SEM_VINCULO_CONFIRMADO");
    } else if (vinculo.origem !== "vps") {
      // O adaptador Google atualmente exige extendedProperties da VPS.
      // Eventos do Apps Script precisam de estrategia de legado propria.
      throw erro("EVENTO_LEGADO_NAO_MIGRADO");
    }

    const operationId = randomUUID();
    await conexao.query(
      `INSERT INTO public.google_calendar_sync_operations (
         operation_id, chave_idempotencia, agendamento_id, calendar_id,
         tipo, google_event_id, fingerprint_pedido, estado
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente')`,
      [operationId, chave, id, calendar, tipo, eventId, fingerprint],
    );
    if (tipo === "criar") {
      const consumida = await conexao.query(
        `UPDATE public.google_calendar_creation_authorizations
         SET consumido_em = NOW()
         WHERE agendamento_id = $1 AND calendar_id = $2
           AND autorizacao = 'nova_reserva_verificada' AND consumido_em IS NULL
         RETURNING agendamento_id`, [id, calendar],
      );
      if (consumida.rows.length !== 1) throw erro("CRIACAO_NAO_AUTORIZADA");
    }
    return { operationId, estado: "pendente", jaRegistrada: false };
  });
}

/**
 * Reclama UMA intencao pendente apenas quando o cutover foi habilitado
 * separadamente. Nunca recupera automaticamente "processando" com lease
 * expirado ou "aguardando_confirmacao": precisam de conciliacao remota.
 * O leaseToken e fencing token entre diferentes containers.
 */
export async function reivindicarIntencaoCalendar(pool, {
  calendarId,
}, { env = process.env } = {}) {
  somenteWorker(env);
  const calendar = validar(calendarId, /^\S{1,300}$/, "CALENDARIO_INVALIDO");
  const leaseToken = randomUUID();
  const r = await pool.query(
    `WITH proxima AS (
       SELECT operation_id FROM public.google_calendar_sync_operations
       WHERE calendar_id = $1 AND estado = 'pendente'
         AND proxima_tentativa_em <= NOW()
       ORDER BY criado_em, operation_id
       LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE public.google_calendar_sync_operations AS op
     SET estado = 'processando', lease_token = $2,
         tentativas = tentativas + 1,
         bloqueado_ate = NOW() + INTERVAL '2 minutes',
         atualizado_em = NOW()
     FROM proxima
     WHERE op.operation_id = proxima.operation_id
     RETURNING op.operation_id, op.agendamento_id, op.calendar_id,
               op.google_event_id, op.tipo, op.lease_token`,
    [calendar, leaseToken],
  );
  return r.rows[0] || null;
}

/**
 * Finalizacao somente apos o Google devolver comprovacao do MESMO evento
 * e marcador privado, sem inferir sucesso a partir de timeout ou HTTP 202.
 * Vinculo e estado da outbox sao alterados na mesma transacao PG.
 */
export async function confirmarIntencaoCalendar(pool, {
  operationId, leaseToken, googleEvent,
}, { env = process.env } = {}) {
  somenteWorker(env);
  const opId = validar(operationId, /^[0-9a-f-]{36}$/i, "OPERACAO_INVALIDA");
  const lease = validar(leaseToken, /^[0-9a-f-]{36}$/i, "LEASE_INVALIDO");
  if (!googleEvent || typeof googleEvent !== "object") throw erro("CONFIRMACAO_AUSENTE");
  return transacao(pool, async con => {
    const r = await con.query(
      `SELECT operation_id, agendamento_id, calendar_id, google_event_id, tipo, estado, lease_token
       FROM public.google_calendar_sync_operations
       WHERE operation_id = $1 FOR UPDATE`, [opId],
    );
    const op = r.rows[0];
    if (!op) throw erro("OPERACAO_AUSENTE");
    if (op.estado === "concluida") return { jaConcluida: true, operationId: opId };
    if (!["processando", "aguardando_confirmacao"].includes(op.estado)) {
      throw erro("OPERACAO_SEM_CONFIRMACAO");
    }
    if (op.lease_token !== lease) throw erro("LEASE_OBSOLETO");
    if (googleEvent.id !== op.google_event_id) throw erro("EVENTO_NAO_CONFIRMADO");
    if (op.tipo === "cancelar") {
      if (googleEvent.status !== "cancelled" && googleEvent.ausenteConfirmado !== true) {
        throw erro("CANCELAMENTO_NAO_CONFIRMADO");
      }
    } else {
      if (googleEvent.status === "cancelled" ||
          googleEvent.extendedProperties?.private?.isabeleOrigem !== "isabele-vps" ||
          googleEvent.extendedProperties?.private?.isabeleAgendamentoId !== op.agendamento_id) {
        throw erro("MARCADOR_GOOGLE_DIVERGENTE");
      }
    }
    if (op.tipo === "criar") {
      const result = await con.query(
        `INSERT INTO public.google_calendar_event_links (
           agendamento_id, calendar_id, google_event_id, origem,
           metodo_verificacao, verificado_em, verificado_por
         ) VALUES ($1,$2,$3,'vps','google_api',NOW(),'api-vps')
         ON CONFLICT DO NOTHING RETURNING agendamento_id`,
        [op.agendamento_id, op.calendar_id, op.google_event_id],
      );
      if (!result.rows.length) {
        const existente = await con.query(
          `SELECT google_event_id, calendar_id, origem, situacao
           FROM public.google_calendar_event_links WHERE agendamento_id = $1 FOR UPDATE`,
          [op.agendamento_id],
        );
        const v = existente.rows[0];
        if (v?.google_event_id !== op.google_event_id ||
            v?.calendar_id !== op.calendar_id ||
            v?.origem !== "vps" || v?.situacao !== "ativo") {
          throw erro("VINCULO_EM_CONFLITO");
        }
      }
    } else {
      const result = await con.query(
        `UPDATE public.google_calendar_event_links
         SET situacao = $4, atualizado_em = NOW()
         WHERE agendamento_id = $1 AND calendar_id = $2
           AND google_event_id = $3 AND origem = 'vps'
           AND situacao = 'ativo'
         RETURNING agendamento_id`,
        [op.agendamento_id, op.calendar_id, op.google_event_id,
          op.tipo === "cancelar" ? "cancelado" : "ativo"],
      );
      if (result.rows.length !== 1) throw erro("VINCULO_EM_CONFLITO");
    }
    await con.query(
      `UPDATE public.google_calendar_sync_operations
       SET estado = 'concluida', concluido_em = NOW(), atualizado_em = NOW(),
           bloqueado_ate = NULL, lease_token = NULL, ultimo_codigo_erro = NULL
       WHERE operation_id = $1 AND lease_token = $2
         AND estado IN ('processando','aguardando_confirmacao')`,
      [opId, lease],
    );
    return { jaConcluida: false, operationId: opId };
  });
}

export async function suspenderIntencaoIncerta(pool, {
  operationId, leaseToken, codigo = "GOOGLE_CALENDAR_SEM_CONFIRMACAO",
}, { env = process.env } = {}) {
  somenteWorker(env);
  const opId = validar(operationId, /^[0-9a-f-]{36}$/i, "OPERACAO_INVALIDA");
  const lease = validar(leaseToken, /^[0-9a-f-]{36}$/i, "LEASE_INVALIDO");
  const cod = validar(codigo, /^[A-Z0-9_]{1,64}$/, "CODIGO_INVALIDO");
  // Nunca voltar automaticamente uma operacao incerta a 'pendente'.
  const r = await pool.query(
    `UPDATE public.google_calendar_sync_operations
     SET estado = 'aguardando_confirmacao', bloqueado_ate = NULL,
         ultimo_codigo_erro = $2, atualizado_em = NOW()
     WHERE operation_id = $1 AND lease_token = $3
       AND estado = 'processando'
     RETURNING operation_id`,
    [opId, cod, lease],
  );
  if (r.rows.length !== 1) throw erro("ESTADO_DIVERGENTE");
  return { operationId: opId, estado: "aguardando_confirmacao" };
}
