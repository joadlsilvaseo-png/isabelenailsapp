/**
 * Conexão OAuth Google Calendar - interface TEMPORÁRIA do painel admin.
 * Mantida isolada para remoção após confirmar a leitura do calendário.
 * A autorização e o controle de admin continuam exclusivos da API.
 */
import { auth } from "./firebase-config.js";

const BASE = "/api/oauth/google";
let usuarioAtual = null;
let botaoConfigurado = false;
let ultimaConsulta = 0;

function elementos() {
  return {
    card: document.getElementById("google-calendar-connect-card"),
    status: document.getElementById("google-calendar-connect-status"),
    botao: document.getElementById("google-calendar-connect-button"),
  };
}

function atualizarEstado(status, botao, mensagem, habilitado = false, conectado = false) {
  status.textContent = mensagem;
  botao.hidden = conectado;
  botao.disabled = !habilitado;
}

async function solicitarApi(caminho, metodo, uidEsperado) {
  const usuario = auth.currentUser;
  if (!usuario || usuario.uid !== uidEsperado) {
    throw new Error("Sessão alterada. Entre novamente na área administrativa.");
  }

  const token = await usuario.getIdToken();
  const resposta = await fetch(BASE + caminho, {
    method: metodo,
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
  });

  let dados = {};
  try {
    dados = await resposta.json();
  } catch {
    throw new Error("Resposta inesperada da API. Tente novamente.");
  }

  if (!resposta.ok) {
    if (resposta.status === 401 || resposta.status === 403) {
      throw new Error("Acesso administrativo não autorizado.");
    }
    throw new Error("Não foi possível consultar o Google Calendar (HTTP " + resposta.status + ").");
  }

  return dados;
}

async function consultarStatus() {
  const { card, status, botao } = elementos();
  if (!card || !status || !botao || !usuarioAtual) return;

  const uid = usuarioAtual.uid;
  const consulta = ++ultimaConsulta;
  card.hidden = false;
  atualizarEstado(status, botao, "Consultando conexão com o Google...", false);

  try {
    const dados = await solicitarApi("/status", "GET", uid);
    if (consulta !== ultimaConsulta || usuarioAtual?.uid !== uid) return;

    if (dados.configurado !== true) {
      atualizarEstado(status, botao, "Integração ainda não configurada.", false);
      return;
    }

    if (dados.conectado !== true) {
      atualizarEstado(status, botao, "Ainda não conectado.", true);
      return;
    }

    atualizarEstado(status, botao, "Autorização encontrada. Verificando leitura...", false);
    const verificacao = await solicitarApi("/check", "GET", uid);
    if (consulta !== ultimaConsulta || usuarioAtual?.uid !== uid) return;

    if (verificacao.conectado === true &&
        verificacao.contaCorreta === true &&
        verificacao.leituraCalendar === true) {
      atualizarEstado(status, botao, "Conectado! Leitura do Google Calendar confirmada.", false, true);
    } else {
      atualizarEstado(status, botao, "Autorização encontrada, mas a leitura não foi confirmada.", false);
    }
  } catch (erro) {
    if (consulta !== ultimaConsulta || usuarioAtual?.uid !== uid) return;
    atualizarEstado(status, botao, erro.message || "Não foi possível consultar a conexão.", false);
  }
}

async function iniciarAutorizacao() {
  const { status, botao } = elementos();
  if (!status || !botao || !usuarioAtual || botao.disabled) return;
  const uid = usuarioAtual.uid;

  atualizarEstado(status, botao, "Abrindo autorização segura do Google...", false);

  try {
    const dados = await solicitarApi("/connect", "POST", uid);
    if (!usuarioAtual || usuarioAtual.uid !== uid) return;

    const url = new URL(dados.authorizationUrl);
    if (url.origin !== "https://accounts.google.com" ||
        url.pathname !== "/o/oauth2/v2/auth") {
      throw new Error("O endereço de autorização não foi reconhecido.");
    }

    // Mesma aba: funciona no Safari/Chrome móvel sem depender de pop-up.
    window.location.assign(url.href);
  } catch (erro) {
    atualizarEstado(status, botao, erro.message || "Não foi possível iniciar a autorização.", true);
  }
}

export function iniciarConexaoGoogleCalendarMobile(usuario) {
  const { card, botao } = elementos();
  if (!card || !botao || !usuario) return;

  usuarioAtual = usuario;
  if (!botaoConfigurado) {
    botao.addEventListener("click", iniciarAutorizacao);
    botaoConfigurado = true;
  }

  void consultarStatus();
}
