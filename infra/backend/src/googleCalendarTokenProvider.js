/**
 * Fase 2.2 - fornecedor de access token e composicao do adaptador Calendar.
 *
 * NAO possui rota HTTP, worker, timer, exportacao de segredo nem efeito ao importar.
 * Reutiliza o refresh token AES-256-GCM da tabela OAuth 023 e a mesma configuracao
 * validada na fase 1. Escrita permanece controlada EXCLUSIVAMENTE pelo adaptador
 * via GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED (false por padrao).
 *
 * Um access token validado fica somente na memoria por no maximo 5 minutos.
 * Nao persistimos access tokens; renovacao e validacao sao "single flight"
 * dentro da mesma instancia para evitar renovacoes simultaneas.
 */
import {
  configuracaoCalendarOAuth,
  criptografarCalendarToken,
  descriptografarCalendarToken,
} from "./googleCalendarOAuth.js";
import { criarAdaptadorGoogleCalendar } from "./googleCalendarEvents.js";

const CONEXAO = "isabele";
const URL_TOKEN = "https://oauth2.googleapis.com/token";
const URL_USUARIO = "https://openidconnect.googleapis.com/v1/userinfo";
const URL_CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/";
const CACHE_MAX_MS = 5 * 60 * 1000;
const ANTECEDENCIA_SEGUNDOS = 60;

function erro(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { codigo });
}

function tokenValido(valor) {
  return typeof valor === "string" && valor.length > 0 && valor.length <= 16384;
}

async function requisitarGoogle(url, opcoes, fetcher) {
  let resposta;
  try {
    resposta = await fetcher(url, {
      ...opcoes,
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    // Nunca incorporar erros do fetch, que podem conter dados da requisicao.
    throw erro("CALENDAR_GOOGLE_INDISPONIVEL", "Servico de autenticacao Google indisponivel.");
  }
  if (!resposta?.ok) {
    // Nao extrair corpo de erro: pode conter tokens ou dados de conta.
    throw erro("CALENDAR_GOOGLE_REJEITOU", "Google recusou a validacao da conexao.");
  }
  try {
    const json = await resposta.json();
    if (!json || typeof json !== "object" || Array.isArray(json)) throw Error();
    return json;
  } catch {
    throw erro("CALENDAR_GOOGLE_RESPOSTA_INVALIDA", "Google retornou resposta invalida.");
  }
}

function confirmarRegistro(row, cfg) {
  if (!row || !tokenValido(row.refresh_token_encrypted)) {
    throw erro("CALENDAR_SEM_CONEXAO", "Conta Google ainda nao conectada.");
  }
  if (typeof row.google_email !== "string" ||
      row.google_email.trim().toLowerCase() !== cfg.expectedEmail) {
    throw erro("CALENDAR_CONTA_DIVERGENTE", "Conta Google nao corresponde a profissional.");
  }
}

/**
 * Entrega somente o adaptador (consultarEvento, criarEvento, atualizarEvento,
 * excluirEvento). A funcao de renovar tokens nao e exportada, e nao existe
 * endpoint para enviar access_token ao frontend.
 */
export function criarAdaptadorGoogleCalendarComOAuth(
  pool,
  { env = process.env, fetcher = fetch, relogio = () => Date.now() } = {},
) {
  if (!pool || typeof pool.query !== "function" ||
      typeof fetcher !== "function" || typeof relogio !== "function") {
    throw erro("CALENDAR_DEPENDENCIAS_INVALIDAS", "Dependencias do Calendar invalidas.");
  }
  const cfg = configuracaoCalendarOAuth(env);
  let cache = null;
  let renovacaoPendente = null;

  async function renovarEValidar() {
    const consulta = await pool.query(
      "SELECT google_email, refresh_token_encrypted FROM public.google_calendar_oauth_credentials WHERE connection_name = $1",
      [CONEXAO],
    );
    const credencial = consulta.rows?.[0];
    confirmarRegistro(credencial, cfg);

    // Mesmo formato de chave e de token usados no callback OAuth ja implantado.
    const refreshToken = descriptografarCalendarToken(
      credencial.refresh_token_encrypted, cfg.key,
    );
    if (!tokenValido(refreshToken)) {
      throw erro("CALENDAR_REFRESH_INVALIDO", "Credencial Google invalida.");
    }

    const tokens = await requisitarGoogle(URL_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "refresh_token",
      }),
    }, fetcher);

    const segundos = Number(tokens.expires_in);
    if (!tokenValido(tokens.access_token) ||
        !Number.isFinite(segundos) || segundos <= 0 || segundos > 86400) {
      throw erro("CALENDAR_ACCESS_INVALIDO", "Google nao devolveu acesso valido.");
    }

    // Confirma novamente identidade e acesso ao calendario, SEM ler eventos
    // pessoais. O GET lista no maximo um ID (na pratica, requisita so 'kind').
    const perfil = await requisitarGoogle(URL_USUARIO, {
      method: "GET",
      headers: { Authorization: "Bearer " + tokens.access_token },
    }, fetcher);
    if (perfil.email_verified !== true ||
        typeof perfil.email !== "string" ||
        perfil.email.trim().toLowerCase() !== cfg.expectedEmail) {
      throw erro("CALENDAR_CONTA_DIVERGENTE", "Conta Google nao corresponde a profissional.");
    }

    const url = new URL(URL_CALENDAR + encodeURIComponent(cfg.calendarId) + "/events");
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("fields", "kind");
    const calendario = await requisitarGoogle(url.toString(), {
      method: "GET",
      headers: { Authorization: "Bearer " + tokens.access_token },
    }, fetcher);
    if (calendario.kind !== "calendar#events") {
      throw erro("CALENDAR_SEM_ACESSO", "Nao foi confirmado acesso ao calendario configurado.");
    }

    // Alguns provedores podem retornar novo refresh token durante uma renovacao.
    // Nunca trocar a credencial antiga por uma resposta sem refresh_token.
    // Se rotacionou, aplicar compare-and-swap para nao sobrescrever
    // uma reconexao mais recente feita pelo callback ou outra instancia.
    const novoRefresh = tokens.refresh_token;
    if (novoRefresh !== undefined && novoRefresh !== null && novoRefresh !== refreshToken) {
      if (!tokenValido(novoRefresh)) {
        throw erro("CALENDAR_REFRESH_INVALIDO", "Novo refresh token invalido.");
      }
      const cifrado = criptografarCalendarToken(novoRefresh, cfg.key);
      const alteracao = await pool.query(
        `UPDATE public.google_calendar_oauth_credentials
         SET refresh_token_encrypted = $1, updated_at = NOW()
         WHERE connection_name = $2 AND google_email = $3 AND refresh_token_encrypted = $4
         RETURNING connection_name`,
        [cifrado, CONEXAO, credencial.google_email, credencial.refresh_token_encrypted],
      );
      if (alteracao.rows?.length !== 1) {
        throw erro("CALENDAR_CREDENCIAL_ALTERADA", "Conexao Google alterada durante renovacao.");
      }
    } else {
      // Mesmo sem rotacao, rejeitar token de uma credencial substituida
      // durante as chamadas externas (por exemplo, nova autorizacao).
      const atual = await pool.query(
        "SELECT google_email, refresh_token_encrypted FROM public.google_calendar_oauth_credentials WHERE connection_name = $1",
        [CONEXAO],
      );
      if (atual.rows?.[0]?.google_email !== credencial.google_email ||
          atual.rows?.[0]?.refresh_token_encrypted !== credencial.refresh_token_encrypted) {
        throw erro("CALENDAR_CREDENCIAL_ALTERADA", "Conexao Google alterada durante renovacao.");
      }
    }

    const ttl = Math.max(0, Math.min(
      CACHE_MAX_MS,
      (segundos - ANTECEDENCIA_SEGUNDOS) * 1000,
    ));
    // Cache exclusivamente em memoria, limitado e sem persistencia no PG.
    cache = { token: tokens.access_token, validoAte: relogio() + ttl };
    return tokens.access_token;
  }

  async function obterAccessToken() {
    if (env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true") {
      throw erro("CALENDAR_OAUTH_DESATIVADO", "Integracao OAuth desativada.");
    }
    if (cache && relogio() < cache.validoAte) return cache.token;
    if (!renovacaoPendente) {
      renovacaoPendente = renovarEValidar().finally(() => {
        renovacaoPendente = null;
      });
    }
    return renovacaoPendente;
  }

  return criarAdaptadorGoogleCalendar({
    calendarId: cfg.calendarId,
    obterAccessToken,
    fetcher,
    env,
  });
}
