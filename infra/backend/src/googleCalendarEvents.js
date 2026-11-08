/**
 * Adaptador isolado para Google Calendar Events API v3.
 *
 * NAO registra rotas, NAO inicia workers e NAO substitui Apps Script.
 * Gravacoes exigem GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=true,
 * separado do flag de OAuth (que ja esta ativo em producao).
 *
 * A integracao que renovar o access token e persistir o googleEventId
 * sera adicionada somente apos reconciliar os eventos legados.
 */
import { createHash } from "node:crypto";

const GOOGLE_API = "https://www.googleapis.com/calendar/v3/calendars/";
const ORIGEM = "isabele-vps";
const FUSO = "America/Sao_Paulo";

function erro(codigo, mensagem) {
  return Object.assign(new Error(mensagem), { codigo });
}

function exigirIdAgendamento(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
    throw erro("AGENDAMENTO_ID_INVALIDO", "Identificador de agendamento invalido.");
  }
  return id;
}

function exigirIdEvento(id) {
  if (typeof id !== "string" || !/^[a-v0-9]{5,1024}$/.test(id)) {
    throw erro("GOOGLE_EVENT_ID_INVALIDO", "Identificador Google Calendar invalido.");
  }
  return id;
}

/**
 * O ID nao e o 'event_id' legado da outbox do Apps Script nem um iCalUID.
 * Usa somente caracteres permitidos para ID da API Google (base32hex).
 * Mantem o mesmo resultado em todas as tentativas da mesma reserva.
 */
export function gerarIdEventoGoogle(agendamentoId) {
  const id = exigirIdAgendamento(agendamentoId);
  return "imn" + createHash("sha256").update("isabele-calendar-v1:" + id).digest("hex");
}

function dataComFuso(valor) {
  if (typeof valor !== "string") throw erro("DATA_CALENDAR_INVALIDA", "Data sem fuso horario.");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(valor);
  if (!m) throw erro("DATA_CALENDAR_INVALIDA", "Informe data ISO 8601 com fuso horario.");
  const [, yy, mm, dd, hh, mi, ss, tz] = m;
  const ano = Number(yy), mes = Number(mm), dia = Number(dd);
  const maxDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  if (ano < 2020 || ano > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > maxDia ||
      Number(hh) > 23 || Number(mi) > 59 || Number(ss) > 59 ||
      (tz !== "Z" && (Number(tz.slice(1, 3)) > 23 || Number(tz.slice(4, 6)) > 59))) {
    throw erro("DATA_CALENDAR_INVALIDA", "Data ou horario invalido.");
  }
  const ms = Date.parse(valor);
  if (!Number.isFinite(ms)) throw erro("DATA_CALENDAR_INVALIDA", "Data invalida.");
  return ms;
}

function textoObrigatorio(valor, campo) {
  if (typeof valor !== "string") throw erro("EVENTO_INCOMPLETO", "Campo obrigatorio: " + campo);
  const normalizado = valor.trim().replace(/\s+/g, " ");
  if (!normalizado || normalizado.length > 160) {
    throw erro("EVENTO_INCOMPLETO", "Campo invalido: " + campo);
  }
  return normalizado;
}

function montarDados({ agendamentoId, nomeCliente, servico, inicio, fim }) {
  const id = exigirIdAgendamento(agendamentoId);
  const nome = textoObrigatorio(nomeCliente, "nomeCliente");
  const procedimento = textoObrigatorio(servico, "servico");
  const ini = dataComFuso(inicio);
  const termin = dataComFuso(fim);
  if (termin <= ini || termin - ini > 24 * 60 * 60 * 1000) {
    throw erro("INTERVALO_CALENDAR_INVALIDO", "Intervalo do atendimento invalido.");
  }
  return {
    summary: procedimento + " - " + nome,
    start: { dateTime: inicio, timeZone: FUSO },
    end: { dateTime: fim, timeZone: FUSO },
    extendedProperties: {
      private: { isabeleAgendamentoId: id, isabeleOrigem: ORIGEM },
    },
  };
}

function exigirPropriedade(evento, idAgendamento) {
  const privateData = evento?.extendedProperties?.private;
  if (privateData?.isabeleAgendamentoId !== idAgendamento ||
      privateData?.isabeleOrigem !== ORIGEM) {
    throw erro("EVENTO_SEM_VINCULO", "Evento nao pertence a este agendamento na integracao direta.");
  }
}

function validarRetorno(evento, eventId, agendamentoId) {
  if (!evento || evento.id !== eventId || evento.status === "cancelled") {
    throw erro("EVENTO_NAO_CONFIRMADO", "Google Calendar nao confirmou o evento esperado.");
  }
  exigirPropriedade(evento, agendamentoId);
  return evento;
}

export function criarAdaptadorGoogleCalendar({
  calendarId, obterAccessToken, fetcher = fetch, env = process.env,
} = {}) {
  if (typeof calendarId !== "string" || !calendarId.trim() ||
      calendarId.length > 300 || /\s/.test(calendarId)) {
    throw erro("CALENDARIO_NAO_CONFIGURADO", "ID do calendario nao configurado.");
  }
  if (typeof obterAccessToken !== "function" || typeof fetcher !== "function") {
    throw erro("CALENDAR_DEPENDENCIA_AUSENTE", "Credenciais ou cliente HTTP indisponiveis.");
  }
  const urlBase = GOOGLE_API + encodeURIComponent(calendarId) + "/events";
  const escrever = () => {
    if (env.GOOGLE_CALENDAR_OAUTH_ENABLED !== "true" ||
        env.GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED !== "true") {
      throw erro("CALENDAR_ESCRITA_DESATIVADA", "Escrita direta no Calendar desativada.");
    }
  };

  async function requisitar(method, url, body, etag) {
    const token = await obterAccessToken();
    if (typeof token !== "string" || !token) {
      throw erro("TOKEN_CALENDAR_AUSENTE", "Conta Google nao conectada.");
    }
    let resposta;
    try {
      resposta = await fetcher(url, {
        method,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(etag ? { "If-Match": etag } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      // Em caso de timeout de escrita, nunca gerar outro ID nem repetir automaticamente.
      throw erro("GOOGLE_CALENDAR_SEM_CONFIRMACAO", "Resposta da API Google indisponivel.");
    }
    if (resposta.status === 404) return { status: 404, body: null };
    if (resposta.status === 409) return { status: 409, body: null };
    if (resposta.status === 412) {
      throw erro("GOOGLE_CALENDAR_CONFLITO_VERSAO", "Evento alterado desde a ultima leitura.");
    }
    if (!resposta.ok) {
      throw erro("GOOGLE_CALENDAR_HTTP_" + String(resposta.status),
        "Google Calendar nao confirmou a operacao.");
    }
    if (resposta.status === 204) return { status: 204, body: null };
    let dados;
    try {
      dados = await resposta.json();
    } catch {
      throw erro("GOOGLE_CALENDAR_RESPOSTA_INVALIDA", "Google Calendar retornou dados invalidos.");
    }
    if (!dados || typeof dados !== "object") {
      throw erro("GOOGLE_CALENDAR_RESPOSTA_INVALIDA", "Google Calendar retornou dados invalidos.");
    }
    return { status: resposta.status, body: dados };
  }

  async function buscar(eventId) {
    const id = exigirIdEvento(eventId);
    const { status, body } = await requisitar("GET", urlBase + "/" + encodeURIComponent(id));
    if (status === 404) return null;
    if (body?.id !== id) {
      throw erro("EVENTO_NAO_CONFIRMADO", "Google Calendar retornou identificador inesperado.");
    }
    return body;
  }

  return {
    async consultarEvento({ eventId }) {
      return buscar(eventId); // Somente leitura, nenhum write flag.
    },

    async criarEvento(dados) {
      escrever();
      const idAgendamento = exigirIdAgendamento(dados?.agendamentoId);
      const eventId = gerarIdEventoGoogle(idAgendamento);
      const corpo = { ...montarDados(dados), id: eventId };
      const retorno = await requisitar("POST", urlBase + "?sendUpdates=none", corpo);
      if (retorno.status === 409) {
        const existente = await buscar(eventId);
        if (!existente) {
          throw erro("GOOGLE_CALENDAR_CONFLITO_INDEFINIDO", "Evento em conflito ainda nao esta visivel.");
        }
        validarRetorno(existente, eventId, idAgendamento);
        return { eventId, criado: false, etag: existente.etag || null };
      }
      const criado = validarRetorno(retorno.body, eventId, idAgendamento);
      return { eventId, criado: true, etag: criado.etag || null };
    },

    async atualizarEvento({ agendamentoId, eventId, nomeCliente, servico, inicio, fim }) {
      escrever();
      const idAgendamento = exigirIdAgendamento(agendamentoId);
      const id = exigirIdEvento(eventId);
      const atual = await buscar(id);
      if (!atual) throw erro("EVENTO_GOOGLE_AUSENTE", "Evento para atualizacao nao encontrado.");
      exigirPropriedade(atual, idAgendamento);
      if (typeof atual.etag !== "string" || !atual.etag) {
        throw erro("ETAG_GOOGLE_AUSENTE", "Versao do evento nao confirmada.");
      }
      const { extendedProperties: _somenteNaCriacao, ...mudancas } =
        montarDados({ agendamentoId, nomeCliente, servico, inicio, fim });
      const retorno = await requisitar(
        "PATCH", urlBase + "/" + encodeURIComponent(id) + "?sendUpdates=none", mudancas, atual.etag,
      );
      return { eventId: id, atualizado: true, etag: validarRetorno(retorno.body, id, idAgendamento).etag || null };
    },

    async excluirEvento({ agendamentoId, eventId }) {
      escrever();
      const idAgendamento = exigirIdAgendamento(agendamentoId);
      const id = exigirIdEvento(eventId);
      const atual = await buscar(id);
      if (!atual) return { eventId: id, excluido: false, jaAusente: true };
      exigirPropriedade(atual, idAgendamento);
      if (typeof atual.etag !== "string" || !atual.etag) {
        throw erro("ETAG_GOOGLE_AUSENTE", "Versao do evento nao confirmada.");
      }
      const retorno = await requisitar(
        "DELETE", urlBase + "/" + encodeURIComponent(id) + "?sendUpdates=none", null, atual.etag,
      );
      if (retorno.status !== 204 && retorno.status !== 404) {
        throw erro("GOOGLE_CALENDAR_RESPOSTA_INVALIDA", "Exclusao nao confirmada pelo Google.");
      }
      return { eventId: id, excluido: retorno.status === 204, jaAusente: retorno.status === 404 };
    },
  };
}
