import { auth } from "./firebase-config.js";

const API = "/api/notificacoes";

let inicializada = false;
let uidAtual = null;
let overflowAnterior = "";

function elementosCentral() {
  return {
    sino: document.getElementById("principal-notification-bell"),
    contador: document.getElementById("principal-notification-count"),
    overlay: document.getElementById("principal-notification-overlay"),
    painel: document.getElementById("principal-notification-panel"),
    fechar: document.getElementById("principal-notification-close"),
    lista: document.getElementById("principal-notification-list"),
    resumo: document.getElementById("principal-notification-summary"),
    lerTodas: document.getElementById("principal-notification-read-all"),
  };
}

async function chamarAPI(caminho = "", metodo = "GET") {
  const usuario = auth.currentUser;

  if (!usuario || usuario.uid !== uidAtual) {
    throw new Error("Sessão não disponível.");
  }

  const token = await usuario.getIdToken();

  const resposta = await fetch(`${API}${caminho}`, {
    method: metodo,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resposta.ok) {
    throw new Error(`Falha na central: HTTP ${resposta.status}`);
  }

  return resposta.json();
}

function destinoSeguro(destino) {
  try {
    const url = new URL(destino || "", window.location.href);

    const paginasPermitidas = [
      "/admin-agendamentos.html",
      "/meu-perfil.html",
      "/principal.html",
    ];

    if (
      url.origin === window.location.origin &&
      paginasPermitidas.includes(url.pathname)
    ) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Destino inválido: retorna à página principal.
  }

  return "principal.html";
}

function formatarData(valor) {
  const data = new Date(valor);

  if (Number.isNaN(data.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(data);
}

function atualizarContador(total, elementos) {
  const quantidade = Math.max(0, Number(total) || 0);

  elementos.contador.textContent = quantidade > 99 ? "99+" : String(quantidade);

  elementos.contador.hidden = quantidade === 0;
  elementos.lerTodas.hidden = quantidade === 0;

  elementos.resumo.textContent =
    quantidade === 0
      ? "Você está em dia!"
      : `${quantidade} notificação${quantidade === 1 ? "" : "ões"} não lida${quantidade === 1 ? "" : "s"}`;

  elementos.sino.setAttribute(
    "aria-label",
    quantidade
      ? `Notificações: ${quantidade} não lidas`
      : "Abrir central de notificações",
  );
}

function criarItem(notificacao) {
  const item = document.createElement("button");

  item.type = "button";
  item.className = "principal-notification-item";

  if (!notificacao.lida_em) {
    item.classList.add("is-unread");
  }

  const titulo = document.createElement("strong");
  titulo.textContent = notificacao.titulo || "Notificação";

  const mensagem = document.createElement("p");
  mensagem.textContent = notificacao.mensagem || "";

  const data = document.createElement("small");
  data.textContent = formatarData(notificacao.criado_em);

  item.append(titulo, mensagem, data);

  item.addEventListener("click", async () => {
    item.disabled = true;

    try {
      if (!notificacao.lida_em) {
        await chamarAPI(`/${encodeURIComponent(notificacao.id)}/lida`, "PATCH");
      }

      window.location.assign(destinoSeguro(notificacao.destino));
    } catch (erro) {
      console.error("[Central] Falha ao abrir notificação:", erro);
      item.disabled = false;
      window.alert("Não foi possível abrir a notificação. Tente novamente.");
    }
  });

  return item;
}

async function carregarNotificacoes() {
  const elementos = elementosCentral();
  const usuarioDaConsulta = uidAtual;

  if (!usuarioDaConsulta) {
    return;
  }

  try {
    const dados = await chamarAPI();

    if (usuarioDaConsulta !== uidAtual) {
      return;
    }

    const notificacoes = Array.isArray(dados.notificacoes)
      ? dados.notificacoes
      : [];

    atualizarContador(dados.naoLidas, elementos);

    elementos.lista.replaceChildren();

    if (notificacoes.length === 0) {
      const vazio = document.createElement("p");
      vazio.className = "principal-notification-empty";
      vazio.textContent = "Você ainda não possui notificações.";

      elementos.lista.appendChild(vazio);
      return;
    }

    notificacoes.forEach((notificacao) => {
      elementos.lista.appendChild(criarItem(notificacao));
    });
  } catch (erro) {
    console.error("[Central] Erro ao carregar:", erro);

    if (!elementos.overlay.hidden) {
      elementos.lista.textContent =
        "Não foi possível carregar as notificações. Tente novamente.";
    }
  }
}

function abrirCentral(elementos) {
  overflowAnterior = document.body.style.overflow;

  elementos.overlay.hidden = false;
  elementos.sino.setAttribute("aria-expanded", "true");

  document.body.style.overflow = "hidden";

  elementos.painel.focus();

  elementos.lista.textContent = "Carregando notificações...";

  carregarNotificacoes();
}

function fecharCentral(elementos) {
  elementos.overlay.hidden = true;
  elementos.sino.setAttribute("aria-expanded", "false");

  document.body.style.overflow = overflowAnterior;
  elementos.sino.focus();
}

export function iniciarCentralNotificacoes(usuario) {
  const elementos = elementosCentral();

  if (
    !usuario ||
    !elementos.sino ||
    !elementos.contador ||
    !elementos.overlay ||
    !elementos.painel ||
    !elementos.fechar ||
    !elementos.lista ||
    !elementos.resumo ||
    !elementos.lerTodas
  ) {
    return;
  }

  uidAtual = usuario.uid;
  elementos.sino.hidden = false;

  if (inicializada) {
    carregarNotificacoes();
    return;
  }

  inicializada = true;

  elementos.sino.addEventListener("click", () => {
    abrirCentral(elementos);
  });

  elementos.fechar.addEventListener("click", () => {
    fecharCentral(elementos);
  });

  elementos.overlay.addEventListener("click", (evento) => {
    if (evento.target === elementos.overlay) {
      fecharCentral(elementos);
    }
  });

  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape" && !elementos.overlay.hidden) {
      fecharCentral(elementos);
    }
  });

  elementos.lerTodas.addEventListener("click", async () => {
    elementos.lerTodas.disabled = true;

    try {
      await chamarAPI("/lidas", "PATCH");
      await carregarNotificacoes();
    } catch (erro) {
      console.error("[Central] Erro ao marcar como lidas:", erro);
      window.alert("Não foi possível atualizar as notificações.");
    } finally {
      elementos.lerTodas.disabled = false;
    }
  });

  // Atualiza o contador periodicamente, sem recarregar a página.
  window.setInterval(() => {
    if (!document.hidden && auth.currentUser) {
      carregarNotificacoes();
    }
  }, 30000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && auth.currentUser) {
      carregarNotificacoes();
    }
  });

  carregarNotificacoes();
}
