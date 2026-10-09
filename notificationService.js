import { app } from "./firebase-config.js";

import {
  getAuth,
  getIdToken,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import { trackEvent } from "./analytics.js";

const auth = getAuth(app);

const API_PUSH = "/api/push";

// ======================================================
// CONVERTER CHAVE VAPID PARA FORMATO DO NAVEGADOR
// ======================================================

function converterChaveVapid(chavePublica) {
  const padding = "=".repeat((4 - (chavePublica.length % 4)) % 4);

  const base64 = (chavePublica + padding).replace(/-/g, "+").replace(/_/g, "/");

  const dados = atob(base64);

  return Uint8Array.from(dados, (caractere) => caractere.charCodeAt(0));
}

// ======================================================
// VERIFICAR SE A INSCRICAO USA A CHAVE VAPID ATUAL
// ======================================================

function mesmaChaveVapid(inscricao, chaveAtual) {
  const chaveExistente = inscricao.options?.applicationServerKey;

  if (!chaveExistente) {
    return false;
  }

  const bytesExistentes = new Uint8Array(chaveExistente);

  return (
    bytesExistentes.length === chaveAtual.length &&
    bytesExistentes.every((valor, indice) => valor === chaveAtual[indice])
  );
}

// ======================================================
// CONFIGURAR WEB PUSH
// ======================================================

async function configurarWebPush(userId, solicitarPermissao = false) {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    console.warn("Web Push não suportado neste navegador.");
    return null;
  }

  if (!window.isSecureContext) {
    console.warn("Web Push exige HTTPS.");
    return null;
  }

  try {
    const usuario = auth.currentUser;

    if (!usuario || (userId && usuario.uid !== userId)) {
      console.warn("Usuário não autenticado para Web Push.");
      return null;
    }

    // Verifica permissão sem abrir uma janela automaticamente.
    let permissao = Notification.permission;

    if (permissao === "default" && solicitarPermissao) {
      permissao = await Notification.requestPermission();
    }

    if (permissao !== "granted") {
      console.info("Notificações ainda não autorizadas.");
      return null;
    }

    // Utiliza o Service Worker existente do aplicativo.
    const registration = await navigator.serviceWorker.ready;

    // Busca a chave pública VAPID na nossa API.
    const respostaChave = await fetch(`${API_PUSH}/public-key`, {
      cache: "no-store",
    });

    if (!respostaChave.ok) {
      throw new Error("Não foi possível obter a chave VAPID.");
    }

    const { publicKey } = await respostaChave.json();

    if (!publicKey) {
      throw new Error("Chave pública VAPID não encontrada.");
    }

    const chaveVapid = converterChaveVapid(publicKey);

    // Verifica se o navegador já possui uma inscrição.
    let inscricao = await registration.pushManager.getSubscription();

    // Substitui inscrições antigas que utilizavam outra chave.
    if (inscricao && !mesmaChaveVapid(inscricao, chaveVapid)) {
      const removida = await inscricao.unsubscribe();

      if (!removida) {
        throw new Error("Não foi possível atualizar a inscrição Push.");
      }

      inscricao = null;
    }

    // Cria a inscrição apenas se necessário.
    if (!inscricao) {
      inscricao = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: chaveVapid,
      });
    }

    // Obtém um token válido da sessão Firebase Authentication.
    const tokenFirebase = await getIdToken(usuario);

    // Registra a inscrição no PostgreSQL por meio da API.
    const resposta = await fetch(`${API_PUSH}/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenFirebase}`,
      },
      body: JSON.stringify(inscricao.toJSON()),
    });

    if (!resposta.ok) {
      throw new Error(
        `Erro ao cadastrar dispositivo Push: HTTP ${resposta.status}`,
      );
    }

    console.log("Dispositivo cadastrado no Web Push.");

    trackEvent("push_subscription_opt_in", {
      user_id: usuario.uid,
      timestamp: new Date().toISOString(),
      status: "granted",
    });

    return inscricao;
  } catch (erro) {
    console.error("Erro ao configurar Web Push:", erro);
    return null;
  }
}

// ======================================================
// CONFIGURACAO AUTOMATICA
// Para usuarios que ja concederam permissao
// ======================================================

export async function setupPushNotifications(userId) {
  return configurarWebPush(userId, false);
}

// ======================================================
// ATIVACAO MANUAL
// Deve ser chamada pelo clique em um botao
// ======================================================

export async function ativarNotificacoes(userId) {
  return configurarWebPush(userId, true);
}
