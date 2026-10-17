import { efetivarAgendamentoPix } from "./pixEfetivacao.js";
import { processarOrderNotificada } from "./pixWebhookWorker.js";

const CHAVE_LOCK_WORKER = [176623091, 118203];
const INTERVALO_CICLO_MS_PADRAO = 10000;
const LIMITE_LOTE_PADRAO = 5;
const LIMITE_RPM_PADRAO = 12;
const HORAS_RECONCILIACAO_PADRAO = 72;
const SEGUNDOS_LEASE = 120;
const SEGUNDOS_MIN_BACKOFF = 15;
const SEGUNDOS_MAX_BACKOFF = 3600;

const metricas = {
  ciclos: 0,
  cobrançasElegiveis: 0,
  consultasMercadoPago: 0,
  aprovacoesConciliadas: 0,
  recuperacoesLocais: 0,
  erros: 0,
  aguardandoAnalise: 0,
  foraDoHorizonte: 0,
  ultimaExecucaoEm: null,
  proximaTentativaEm: null,
};
const consultasRecentes = [];
let ultimoLogFilaVazia = 0;

function inteiroEnv(nome, padrao, minimo, maximo) {
  const valor = Number(process.env[nome]);
  if (!Number.isInteger(valor)) return padrao;
  return Math.max(minimo, Math.min(maximo, valor));
}

export function configuracaoPixPolling() {
  const tokenTeste = process.env.MP_ACCESS_TOKEN_TEST?.trim() || "";
  const tokenProducao = process.env.MP_ACCESS_TOKEN_PRODUCTION?.trim() || "";
  const ambienteTesteAtivo = process.env.PIX_TEST_ORDERS_ENABLED === "true" &&
    /^(APP_USR-|TEST-)/.test(tokenTeste);
  const ambienteProducaoAtivo = process.env.PIX_PRODUCTION_ORDERS_ENABLED === "true" &&
    tokenProducao.startsWith("APP_USR-");

  return {
    habilitado: process.env.PIX_POLLING_WORKER_ENABLED === "true",
    ambientes: [
      ...(ambienteTesteAtivo ? ["test"] : []),
      ...(ambienteProducaoAtivo ? ["production"] : []),
    ],
    limiteLote: inteiroEnv("PIX_POLLING_MAX_PER_CYCLE", LIMITE_LOTE_PADRAO, 1, 20),
    limitePorMinuto: inteiroEnv("PIX_POLLING_MAX_REQUESTS_PER_MINUTE", LIMITE_RPM_PADRAO, 1, 60),
    intervaloCicloMs: inteiroEnv("PIX_POLLING_IDLE_INTERVAL_MS", INTERVALO_CICLO_MS_PADRAO, 2000, 60000),
    horizonteHoras: inteiroEnv("PIX_POLLING_RECONCILIATION_HOURS", HORAS_RECONCILIACAO_PADRAO, 1, 168),
    intervaloInicialSegundos: inteiroEnv("PIX_POLLING_INITIAL_INTERVAL_SECONDS", 30, 15, 900),
    intervaloAposReservaSegundos: inteiroEnv("PIX_POLLING_AFTER_EXPIRY_INTERVAL_SECONDS", 120, 30, 3600),
    intervaloAntigoSegundos: inteiroEnv("PIX_POLLING_OLD_ORDER_INTERVAL_SECONDS", 300, 60, 7200),
    intervaloFinalSegundos: inteiroEnv("PIX_POLLING_FINAL_INTERVAL_SECONDS", 1800, 300, 21600),
  };
}

function backoffErro(tentativas, retryAfterSeconds, aleatorio = Math.random) {
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    // Mercado Pago orienta aguardar o Retry-After; não encurtamos esse prazo.
    return Math.min(2147483647, Math.ceil(retryAfterSeconds));
  }
  const expoente = Math.min(Math.max(tentativas - 1, 0), 8);
  const base = Math.min(SEGUNDOS_MAX_BACKOFF, SEGUNDOS_MIN_BACKOFF * (2 ** expoente));
  const jitter = 0.8 + (aleatorio() * 0.4);
  return Math.max(SEGUNDOS_MIN_BACKOFF, Math.ceil(base * jitter));
}

export function segundosProximaConsulta({ tentativas, criado_em, vence_em, agora = Date.now(), erroRetryAfter, config = configuracaoPixPolling() }) {
  if (erroRetryAfter) return backoffErro(tentativas, erroRetryAfter);
  const criado = new Date(criado_em).getTime();
  const vencimento = new Date(vence_em).getTime();
  const idadeSegundos = Number.isFinite(criado) ? Math.max(0, (agora - criado) / 1000) : 0;
  if (Number.isFinite(vencimento) && agora <= vencimento) {
    return idadeSegundos < 300 ? config.intervaloInicialSegundos : Math.max(config.intervaloInicialSegundos, 60);
  }
  if (idadeSegundos < 7200) return config.intervaloAposReservaSegundos;
  if (idadeSegundos < 86400) return config.intervaloAntigoSegundos;
  return config.intervaloFinalSegundos;
}

function categoriaErro(erro) {
  if (erro?.status === 429) return "rate_limited";
  if (erro?.status >= 500) return "mercado_pago_5xx";
  if (erro?.status === 401 || erro?.status === 403) return "credencial_mercado_pago";
  if (erro?.name === "AbortError" || erro?.name === "TimeoutError" || erro?.code === "ETIMEDOUT") return "timeout";
  if (/nao corresponde|divergente|invalida/i.test(String(erro?.message || ""))) return "integridade_requer_revisao";
  return "falha_temporaria";
}

async function adquirirLockGlobal(pool) {
  const conexao = await pool.connect();
  try {
    const resultado = await conexao.query(
      "SELECT pg_try_advisory_lock($1, $2) AS adquirido",
      CHAVE_LOCK_WORKER,
    );
    if (resultado.rows[0]?.adquirido !== true) {
      conexao.release();
      return null;
    }
    return conexao;
  } catch (erro) {
    conexao.release();
    throw erro;
  }
}

async function liberarLockGlobal(conexao) {
  if (!conexao) return;
  try {
    await conexao.query("SELECT pg_advisory_unlock($1, $2)", CHAVE_LOCK_WORKER);
  } finally {
    conexao.release();
  }
}

export async function reservarCobrancasElegiveis(pool, config) {
  const antigas = await pool.query(`
    WITH candidatas AS (
      SELECT id
      FROM public.pix_cobrancas
      WHERE estado = 'pendente'
        AND mp_order_id IS NOT NULL
        AND pix_polling_next_at IS NOT NULL
        AND pix_polling_next_at <= NOW()
        AND (pix_polling_lease_until IS NULL OR pix_polling_lease_until <= NOW())
        AND criado_em < NOW() - ($1::integer * INTERVAL '1 hour')
      ORDER BY pix_polling_next_at, criado_em
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.pix_cobrancas AS c
    SET pix_polling_next_at = NULL,
        pix_polling_lease_until = NULL,
        pix_polling_last_error = 'horizonte_reconciliacao_encerrado',
        atualizado_em = NOW()
    FROM candidatas
    WHERE c.id = candidatas.id
    RETURNING c.id
  `, [config.horizonteHoras]);
  metricas.foraDoHorizonte += antigas.rowCount || 0;

  const resultado = await pool.query(`
    WITH candidatas AS (
      SELECT c.id, c.estado
      FROM public.pix_cobrancas AS c
      LEFT JOIN public.pix_reservas AS r ON r.cobranca_id = c.id
      WHERE c.mp_order_id IS NOT NULL
        AND c.mp_environment = ANY($3::text[])
        AND c.pix_polling_next_at IS NOT NULL
        AND c.pix_polling_next_at <= NOW()
        AND (c.pix_polling_lease_until IS NULL OR c.pix_polling_lease_until <= NOW())
        AND (c.estado = 'paga' OR c.criado_em >= NOW() - ($4::integer * INTERVAL '1 hour'))
        AND (
          c.estado = 'pendente'
          OR (
            c.estado = 'paga'
            AND r.estado IN ('reservada', 'expirada')
          )
        )
      ORDER BY c.pix_polling_next_at, c.criado_em
      LIMIT $1
      FOR UPDATE OF c SKIP LOCKED
    ), reclamadas AS (
      UPDATE public.pix_cobrancas AS c
      SET pix_polling_lease_until = NOW() + ($2 * INTERVAL '1 second'),
          pix_polling_attempts = c.pix_polling_attempts + 1
      FROM candidatas
      WHERE c.id = candidatas.id
      RETURNING c.id, c.cliente_uid, c.mp_environment, c.mp_order_id, c.estado,
        c.pix_polling_attempts, c.criado_em, c.vence_em, c.agendamento_id
    )
    SELECT reclamadas.*, r.estado AS reserva_estado
    FROM reclamadas
    LEFT JOIN public.pix_reservas AS r ON r.cobranca_id = reclamadas.id
    ORDER BY reclamadas.criado_em
  `, [config.limiteLote, SEGUNDOS_LEASE, config.ambientes, config.horizonteHoras]);
  return resultado.rows;
}

async function salvarResultado(pool, cobranca, { proximaEmSegundos = null, erro = null } = {}) {
  const nextAt = proximaEmSegundos === null
    ? null
    : new Date(Date.now() + proximaEmSegundos * 1000).toISOString();
  await pool.query(`
    UPDATE public.pix_cobrancas
    SET pix_polling_next_at = CASE
          WHEN $2::integer IS NULL THEN NULL
          ELSE NOW() + ($2 * INTERVAL '1 second')
        END,
        pix_polling_lease_until = NULL,
        pix_polling_last_error = $3,
        atualizado_em = NOW()
    WHERE id = $1 AND mp_environment = $4 AND mp_order_id = $5
  `, [cobranca.id, proximaEmSegundos, erro, cobranca.mp_environment, cobranca.mp_order_id]);
  if (proximaEmSegundos !== null && (!metricas.proximaTentativaEm || nextAt < metricas.proximaTentativaEm)) {
    metricas.proximaTentativaEm = nextAt;
  }
}

function criarLimitador(config, dependencias = {}) {
  const agora = dependencias.agora || Date.now;
  const pausar = dependencias.pausar || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async () => {
    while (true) {
      const agoraMs = agora();
      while (consultasRecentes.length && agoraMs - consultasRecentes[0] >= 60000) consultasRecentes.shift();
      if (consultasRecentes.length < config.limitePorMinuto) {
        consultasRecentes.push(agoraMs);
        return;
      }
      await pausar(Math.max(1, 60000 - (agoraMs - consultasRecentes[0])));
    }
  };
}

export async function processarCicloPixPolling(pool, dependencias = {}) {
  const config = dependencias.config || configuracaoPixPolling();
  if (!config.habilitado || config.ambientes.length === 0) {
    return { situacao: "desabilitado", elegiveis: 0, consultas: 0, conciliadas: 0, erros: 0 };
  }

  const lockGlobal = dependencias.adquirirLock || adquirirLockGlobal;
  const lock = await lockGlobal(pool);
  if (!lock) return { situacao: "worker_concorrente", elegiveis: 0, consultas: 0, conciliadas: 0, erros: 0 };

  const reservar = dependencias.reservar || reservarCobrancasElegiveis;
  const salvar = dependencias.salvarResultado || salvarResultado;
  const processarOrder = dependencias.processarOrder || ((id, ambiente) => processarOrderNotificada(pool, id, ambiente));
  const efetivar = dependencias.efetivarAgendamento || efetivarAgendamentoPix;
  const aguardarLimite = criarLimitador(config, dependencias);
  let consultas = 0;
  let conciliadas = 0;
  let recuperacoesLocais = 0;
  let erros = 0;
  let revisao = 0;

  try {
    metricas.proximaTentativaEm = null;
    const cobrancas = await reservar(pool, config);
    metricas.ciclos += 1;
    metricas.cobrançasElegiveis += cobrancas.length;

    if (cobrancas.length === 0 && Date.now() - ultimoLogFilaVazia >= 300000) {
      ultimoLogFilaVazia = Date.now();
      console.info("[PIX Polling] ciclo", JSON.stringify({
        situacao: "fila_vazia", elegiveis: 0, consultas: 0, conciliadas: 0,
        recuperacoesLocais: 0, erros: 0, proximaTentativaEm: metricas.proximaTentativaEm,
        foraDoHorizonte: metricas.foraDoHorizonte,
      }));
    }

    for (const cobranca of cobrancas) {
      if (cobranca.estado === "paga") {
        recuperacoesLocais += 1;
        try {
          const resultado = await efetivar({
            pool,
            cobrancaId: cobranca.id,
            uid: cobranca.cliente_uid,
          });
          conciliadas += resultado?.agendamentoConfirmado ? 1 : 0;
          await salvar(pool, cobranca, { proximaEmSegundos: null, erro: null });
        } catch (erro) {
          if (erro?.requerAnalise) {
            revisao += 1;
            await salvar(pool, cobranca, { erro: "pagamento_creditado_requer_analise" });
          } else {
            erros += 1;
            const espera = backoffErro(cobranca.pix_polling_attempts || 1, null);
            await salvar(pool, cobranca, { proximaEmSegundos: espera, erro: "efetivacao_temporaria" });
          }
        }
        continue;
      }

      await aguardarLimite();
      consultas += 1;
      try {
        const resultado = await processarOrder(cobranca.mp_order_id, cobranca.mp_environment);
        if (resultado?.concluido) {
          conciliadas += resultado?.pagamentoCreditado ? 1 : 0;
          revisao += resultado?.situacao === "pago_requer_analise" ? 1 : 0;
          // Estados encerrados e pagos não são consultados de novo. Quando o
          // pagamento existe, mas a reserva exige análise, fica fora do polling.
          await salvar(pool, cobranca, { proximaEmSegundos: null, erro: null });
        } else {
          const espera = segundosProximaConsulta({ ...cobranca, config });
          await salvar(pool, cobranca, { proximaEmSegundos: espera, erro: null });
        }
      } catch (erro) {
        erros += 1;
        const categoria = categoriaErro(erro);
        const espera = categoria === "integridade_requer_revisao"
          ? null
          : backoffErro(cobranca.pix_polling_attempts || 1, erro?.retryAfterSeconds);
        await salvar(pool, cobranca, { proximaEmSegundos: espera, erro: categoria });
      }
    }

    metricas.consultasMercadoPago += consultas;
    metricas.aprovacoesConciliadas += conciliadas;
    metricas.recuperacoesLocais += recuperacoesLocais;
    metricas.erros += erros;
    metricas.aguardandoAnalise += revisao;
    metricas.ultimaExecucaoEm = new Date().toISOString();

    const resumo = { situacao: "processado", elegiveis: cobrancas.length, consultas, conciliadas, recuperacoesLocais, erros, aguardandoAnalise: revisao, foraDoHorizonte: metricas.foraDoHorizonte, proximaTentativaEm: metricas.proximaTentativaEm };
    if (cobrancas.length) console.info("[PIX Polling] ciclo", JSON.stringify(resumo));
    return resumo;
  } finally {
    await (dependencias.liberarLock || liberarLockGlobal)(lock);
  }
}

export function obterMetricasPixPolling() {
  return { ...metricas };
}

export function iniciarWorkerPixPolling(pool, dependencias = {}) {
  const config = configuracaoPixPolling();
  if (!config.habilitado) {
    console.info("[PIX Polling] worker desabilitado por configuração.");
    return () => {};
  }
  if (config.ambientes.length === 0) {
    console.info("[PIX Polling] nenhum ambiente permitido com credencial válida; worker não iniciado.");
    return () => {};
  }

  const pausar = dependencias.pausar || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let encerrado = false;
  const executar = async () => {
    while (!encerrado) {
      try {
        const resultado = await processarCicloPixPolling(pool, dependencias);
        if (resultado.elegiveis === 0) await pausar(config.intervaloCicloMs);
      } catch (erro) {
        metricas.erros += 1;
        console.error("[PIX Polling] falha no ciclo; detalhes sensíveis omitidos.", categoriaErro(erro));
        await pausar(config.intervaloCicloMs);
      }
    }
  };
  console.info("[PIX Polling] worker ativo.", JSON.stringify({ ambientes: config.ambientes, limiteLote: config.limiteLote, limitePorMinuto: config.limitePorMinuto, horizonteHoras: config.horizonteHoras }));
  executar();
  return () => { encerrado = true; };
}
