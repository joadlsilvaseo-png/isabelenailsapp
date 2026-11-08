/**
 * Persistencia isolada da transicao Google Calendar.
 *
 * NAO importado pelo servidor, NAO inicia fila, NAO chama Google.
 * Todas as mutacoes exigem opt-in global e por fluxo. Nunca reexecuta
 * escrita de resultado incerto; lease expirado vira confirmacao pendente.
 *
 * Somente dados de operacao/IDs, nunca nomes, tokens ou valores PIX.
 */
import { randomUUID } from "node:crypto";
import { gerarIdEventoGoogle } from "./googleCalendarEvents.js";
import { decidirRotaGoogleCalendar, flagsGoogleCalendarCutover } from "./googleCalendarCutoverPolicy.js";

const TIPOS = ["criar", "reagendar", "cancelar", "alterar_servico"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENDAMENTO = /^[a-zA-Z0-9_-]{1,128}$/;
const EVENTO = /^[a-zA-Z0-9_-]{5,1024}$/;
const SHA = /^[a-f0-9]{64}$/;

function erro(codigo) {
  return Object.assign(new Error("Calendar cutover: " + codigo), { codigo });
}
function confirmar(condicao, codigo) {
  if (!condicao) throw erro(codigo);
}
function validarUid(valor) {
  confirmar(typeof valor === "string" && AGENDAMENTO.test(valor), "AGENDAMENTO_INVALIDO");
}
function validarEvento(valor) {
  confirmar(typeof valor === "string" && EVENTO.test(valor), "EVENTO_INVALIDO");
}
function validarTipo(tipo) {
  confirmar(TIPOS.includes(tipo), "TIPO_INVALIDO");
}
function flagTipo(flags, tipo) {
  return {
    criar: flags.criar, reagendar: flags.reagendar,
    cancelar: flags.cancelar, alterar_servico: flags.alterarServico,
  }[tipo];
}

export function criarRepositorioCalendarCutover(pool, {
  env = process.env, calendarId, uuid = randomUUID,
} = {}) {
  confirmar(typeof pool?.connect === "function" && typeof pool?.query === "function", "POOL_INVALIDO");
  confirmar(typeof calendarId === "string" && calendarId.length > 0 && calendarId.length <= 300 &&
    !/\s/.test(calendarId), "CALENDARIO_INVALIDO");
  confirmar(typeof uuid === "function", "GERADOR_INVALIDO");

  function verificarFlag(tipo) {
    const flags = flagsGoogleCalendarCutover(env);
    confirmar(flags.global && flagTipo(flags, tipo), "CORTE_NAO_AUTORIZADO");
  }

  async function transacao(callback) {
    const client = await pool.connect();
    let comecou = false;
    try {
      await client.query("BEGIN");
      comecou = true;
      const valor = await callback(client);
      await client.query("COMMIT");
      return valor;
    } catch (e) {
      if (comecou) await client.query("ROLLBACK").catch(() => {});
      if (e?.code === "23505") throw erro("OPERACAO_CONCORRENTE_OU_VINCULO_DUPLICADO");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Cria intent duravel SOMENTE depois de decisao explicita e preflight.
   * O parametro de elegibilidade e um contrato interno do backend, jamais
   * deve ser preenchido com dados diretamente enviados pelo navegador.
   */
  async function prepararIntencao({
    operationId, chaveIdempotencia, agendamentoId, tipo,
    fingerprintPedido, googleEventId, estadoConciliacao = "nao_verificado",
    agendamentoNovoAposCorte = false,
  }) {
    validarTipo(tipo);
    verificarFlag(tipo);
    confirmar(UUID.test(operationId), "OPERACAO_ID_INVALIDO");
    confirmar(typeof chaveIdempotencia === "string" &&
      chaveIdempotencia.length >= 16 && chaveIdempotencia.length <= 160,
    "CHAVE_IDEMPOTENCIA_INVALIDA");
    validarUid(agendamentoId);
    confirmar(SHA.test(fingerprintPedido), "FINGERPRINT_INVALIDO");
    if (tipo === "criar") {
      const idEsperado = gerarIdEventoGoogle(agendamentoId);
      confirmar(!googleEventId || googleEventId === idEsperado, "EVENTO_CRIACAO_DIVERGENTE");
      googleEventId = idEsperado;
    } else {
      validarEvento(googleEventId);
    }

    return transacao(async client => {
      // Idempotencia ANTES do preflight: repeticao da chave devolve
      // sempre a mesma operacao, inclusive se ja foi concluida.
      const existente = await client.query(
        `SELECT operation_id, chave_idempotencia, agendamento_id, calendar_id,
                tipo, google_event_id, fingerprint_pedido, estado
         FROM public.google_calendar_sync_operations
         WHERE chave_idempotencia = $1 FOR UPDATE`,
        [chaveIdempotencia],
      );
      const atual = existente.rows[0];
      if (atual) {
        confirmar(atual.operation_id === operationId &&
          atual.agendamento_id === agendamentoId &&
          atual.calendar_id === calendarId &&
          atual.tipo === tipo &&
          atual.google_event_id === googleEventId &&
          atual.fingerprint_pedido === fingerprintPedido,
        "IDEMPOTENCIA_DIVERGENTE");
        return { operationId, estado: atual.estado, reutilizada: true };
      }

      const links = await client.query(
        `SELECT agendamento_id, calendar_id, google_event_id, origem, situacao
         FROM public.google_calendar_event_links
         WHERE agendamento_id = $1 FOR UPDATE`,
        [agendamentoId],
      );
      const vinculo = links.rows[0] || null;
      let outboxLegadaPresente = null;
      if (tipo === "criar") {
        const antiga = await client.query(
          `SELECT 1 FROM public.pix_calendar_outbox
           WHERE agendamento_id = $1 LIMIT 1`,
          [agendamentoId],
        );
        outboxLegadaPresente = antiga.rows.length > 0;
      }
      if (vinculo && tipo !== "criar") {
        confirmar(vinculo.google_event_id === googleEventId, "EVENTO_VINCULO_DIVERGENTE");
      }
      const rota = decidirRotaGoogleCalendar({
        tipo, env, vinculo, calendarioId: calendarId,
        estadoConciliacao, agendamentoNovoAposCorte,
        outboxLegadaPresente, operacaoPendente: false,
      });
      confirmar(rota.rota === "google_direto", rota.motivo);

      const resultado = await client.query(
        `INSERT INTO public.google_calendar_sync_operations (
            operation_id, chave_idempotencia, agendamento_id, calendar_id,
            tipo, google_event_id, fingerprint_pedido
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (chave_idempotencia) DO NOTHING
         RETURNING operation_id`,
        [operationId, chaveIdempotencia, agendamentoId, calendarId,
          tipo, googleEventId, fingerprintPedido],
      );
      if (resultado.rows.length !== 1) {
        // Outra transacao inseriu a chave: nao assumir sucesso de forma cega.
        throw erro("CHAVE_IDEMPOTENCIA_CONCORRENTE");
      }
      return { operationId, estado: "pendente", reutilizada: false };
    });
  }

  /**
   * Lease adquirido atomicamente. Quando expira, NUNCA volta
   * automaticamente a pendente: uma operacao Google pode ter ocorrido.
   */
  async function reivindicarProxima() {
    const flags = flagsGoogleCalendarCutover(env);
    if (!flags.global) return null;
    const tiposPermitidos = TIPOS.filter(t => flagTipo(flags, t));
    if (!tiposPermitidos.length) return null;
    const claim = uuid();
    confirmar(UUID.test(claim), "LEASE_INVALIDO");
    const resp = await pool.query(
      `WITH proxima AS (
         SELECT operation_id FROM public.google_calendar_sync_operations
         WHERE estado = 'pendente' AND proxima_tentativa_em <= NOW()
           AND tipo = ANY($2::text[])
         ORDER BY criado_em, operation_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE public.google_calendar_sync_operations AS fila
       SET estado = 'processando', lease_token = $1::uuid,
           bloqueado_ate = NOW() + INTERVAL '2 minutes',
           tentativas = tentativas + 1, atualizado_em = NOW()
       FROM proxima WHERE fila.operation_id = proxima.operation_id
       RETURNING fila.operation_id, fila.chave_idempotencia, fila.agendamento_id,
                 fila.calendar_id, fila.tipo, fila.google_event_id,
                 fila.fingerprint_pedido, fila.lease_token, fila.estado`,
      [claim, tiposPermitidos],
    );
    return resp.rows[0] || null;
  }

  async function registrarResultadoIncerto({ operationId, leaseToken, codigoErro }) {
    confirmar(UUID.test(operationId) && UUID.test(leaseToken), "LEASE_INVALIDO");
    confirmar(typeof codigoErro === "string" && /^[A-Z0-9_]{1,64}$/.test(codigoErro),
      "CODIGO_ERRO_INVALIDO");
    const resultado = await pool.query(
      `UPDATE public.google_calendar_sync_operations
       SET estado = 'aguardando_confirmacao', lease_token = NULL,
           bloqueado_ate = NULL, ultimo_codigo_erro = $3,
           atualizado_em = NOW()
       WHERE operation_id = $1 AND lease_token = $2::uuid
         AND estado = 'processando' AND bloqueado_ate > NOW()
       RETURNING operation_id`,
      [operationId, leaseToken, codigoErro],
    );
    confirmar(resultado.rows.length === 1, "LEASE_PERDIDO");
    return { operationId, estado: "aguardando_confirmacao" };
  }

  async function bloquearLeasesExpirados() {
    const flags = flagsGoogleCalendarCutover(env);
    if (!flags.global) return 0;
    const resultado = await pool.query(
      `UPDATE public.google_calendar_sync_operations
       SET estado = 'aguardando_confirmacao', lease_token = NULL,
           bloqueado_ate = NULL, ultimo_codigo_erro = 'LEASE_EXPIRADO',
           atualizado_em = NOW()
       WHERE estado = 'processando' AND bloqueado_ate <= NOW()
       RETURNING operation_id`,
    );
    return resultado.rows.length;
  }

  /**
   * Pos-GET: confirmar que o Google devolveu o evento criado pela VPS.
   * Persiste vinculo + conclusao na MESMA transacao. Se PG falhar,
   * o lease expira e exige reconciliacao, sem novo insert remoto.
   */
  async function confirmarCriacao({ operationId, leaseToken, evento }) {
    verificarFlag("criar");
    confirmar(UUID.test(operationId) && UUID.test(leaseToken), "LEASE_INVALIDO");
    return transacao(async client => {
      const r = await client.query(
        `SELECT operation_id, agendamento_id, google_event_id, calendar_id,
                tipo, estado, lease_token, (bloqueado_ate > NOW()) AS lease_vigente
         FROM public.google_calendar_sync_operations
         WHERE operation_id = $1 FOR UPDATE`,
        [operationId],
      );
      const op = r.rows[0];
      confirmar(op?.tipo === "criar" && op.estado === "processando" &&
        op.lease_token === leaseToken && op.lease_vigente === true &&
        op.calendar_id === calendarId, "LEASE_PERDIDO");
      confirmar(op.google_event_id === gerarIdEventoGoogle(op.agendamento_id),
        "EVENTO_CRIACAO_DIVERGENTE");
      confirmar(evento?.id === op.google_event_id && evento.status !== "cancelled" &&
        evento.extendedProperties?.private?.isabeleOrigem === "isabele-vps" &&
        evento.extendedProperties?.private?.isabeleAgendamentoId === op.agendamento_id,
        "EVENTO_GOOGLE_NAO_VERIFICADO");

      const links = await client.query(
        `INSERT INTO public.google_calendar_event_links (
           agendamento_id, calendar_id, google_event_id, origem,
           metodo_verificacao, verificado_em, verificado_por
         ) VALUES ($1, $2, $3, 'vps', 'google_api', NOW(), $4)
         ON CONFLICT (agendamento_id) DO NOTHING RETURNING agendamento_id`,
        [op.agendamento_id, calendarId, op.google_event_id, "cutover:" + operationId],
      );
      if (!links.rows.length) {
        const atual = await client.query(
          `SELECT calendar_id, google_event_id, origem, situacao
           FROM public.google_calendar_event_links
           WHERE agendamento_id = $1 FOR UPDATE`,
          [op.agendamento_id],
        );
        confirmar(atual.rows[0]?.calendar_id === calendarId &&
          atual.rows[0]?.google_event_id === op.google_event_id &&
          atual.rows[0]?.origem === "vps" &&
          atual.rows[0]?.situacao === "ativo", "VINCULO_DIVERGENTE");
      }

      const confirmado = await client.query(
        `UPDATE public.google_calendar_sync_operations
         SET estado = 'concluida', lease_token = NULL, bloqueado_ate = NULL,
             ultimo_codigo_erro = NULL, concluido_em = NOW(), atualizado_em = NOW()
         WHERE operation_id = $1 AND lease_token = $2::uuid AND estado = 'processando'
           AND bloqueado_ate > NOW() RETURNING operation_id`,
        [operationId, leaseToken],
      );
      confirmar(confirmado.rows.length === 1, "LEASE_PERDIDO");
      return { operationId, googleEventId: op.google_event_id, concluida: true };
    });
  }

  return Object.freeze({
    prepararIntencao, reivindicarProxima, registrarResultadoIncerto,
    bloquearLeasesExpirados, confirmarCriacao,
  });
}
