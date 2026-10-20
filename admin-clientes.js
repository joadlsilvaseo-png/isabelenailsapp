import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { salvarIsencaoComReversao } from "./admin-clientes-state.js";

const $ = (id) => document.getElementById(id);
const list = $("clients-list");
const count = $("clients-count");
const empty = $("empty-state");
const errorBox = $("clients-error");
const search = $("search-input");
const moreButton = $("load-more");
const modal = $("client-modal");
const modalPanel = modal.querySelector(".client-modal");
const exemption = $("client-pix-exemption");
let cursor = null;
let hasMore = false;
let query = "";
let loading = false;
let pendingReload = false;
let debounce;
let queryVersion = 0;
let profileVersion = 0;
let activeUid = null;
let fotoModalUrl = null;
let modalReturnFocus = null;

const fotosCartoesUrls = new Map();

function limparFotosCartoes() {
  for (const url of fotosCartoesUrls.values()) {
    URL.revokeObjectURL(url);
  }

  fotosCartoesUrls.clear();
}

async function carregarFotoCartao(uid, avatar, cartao) {
  let urlTemporaria = null;

  try {
    const usuario = auth.currentUser;
    if (!usuario) return;

    const token = await usuario.getIdToken();

    const resposta = await fetch(
      `/api/admin/clientes/${encodeURIComponent(uid)}/foto`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );

    if (resposta.status === 404) return;

    if (!resposta.ok) {
      throw new Error(`HTTP ${resposta.status}`);
    }

    const tipo = resposta.headers
      .get("Content-Type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();

    if (tipo !== "image/webp") {
      throw new Error("Formato de imagem inesperado.");
    }

    const arquivo = await resposta.blob();

    urlTemporaria = URL.createObjectURL(arquivo);

    const imagem = new Image();
    imagem.alt = "";
    imagem.src = urlTemporaria;

    await imagem.decode();

    // Não atualiza cartões removidos nem outra sessão.
    if (!cartao.isConnected || auth.currentUser?.uid !== usuario.uid) {
      return;
    }

    avatar.replaceChildren(imagem);

    fotosCartoesUrls.set(cartao, urlTemporaria);
    urlTemporaria = null;
  } catch (erro) {
    console.warn("Foto da cliente indisponível:", erro.message);
  } finally {
    if (urlTemporaria) {
      URL.revokeObjectURL(urlTemporaria);
    }
  }
}

function initials(value) {
  return (
    String(value || "Cliente")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || "")
      .join("")
      .toUpperCase() || "CL"
  );
}

function friendlyDate(value) {
  if (!value) return "—";
  const raw = String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
    .format(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .replace(".", "");
}

function showError(message = "") {
  $("clients-error-message").textContent = message;
  $("clients-retry").hidden = !message;
  errorBox.hidden = !message;
}

async function apiFetch(path, options = {}) {
  const user = auth.currentUser;
  if (!user)
    throw new Error("Sessão administrativa encerrada. Entre novamente.");
  const token = await user.getIdToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.erro || "Não foi possível concluir a solicitação.");
  return data;
}

function liberarFotoModal() {
  if (fotoModalUrl) {
    URL.revokeObjectURL(fotoModalUrl);
    fotoModalUrl = null;
  }
}

async function carregarFotoModal(uid, version) {
  let url = null;

  try {
    const usuario = auth.currentUser;
    if (!usuario) return;

    const token = await usuario.getIdToken();

    const resposta = await fetch(
      `/api/admin/clientes/${encodeURIComponent(uid)}/foto`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );

    // Sem foto personalizada: preserva as iniciais.
    if (resposta.status === 404) return;

    if (!resposta.ok) {
      throw new Error(`HTTP ${resposta.status}`);
    }

    const tipo = resposta.headers
      .get("Content-Type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();

    if (tipo !== "image/webp") {
      throw new Error("Formato de imagem inesperado.");
    }

    const arquivo = await resposta.blob();
    url = URL.createObjectURL(arquivo);

    const imagem = new Image();
    imagem.alt = "";
    imagem.src = url;

    await imagem.decode();

    // Impede que a foto de outra cliente apareça.
    if (version !== profileVersion || activeUid !== uid || modal.hidden) {
      return;
    }

    liberarFotoModal();

    fotoModalUrl = url;
    url = null;

    $("modal-avatar").replaceChildren(imagem);
  } catch (erro) {
    console.warn("Foto da cliente indisponível:", erro.message);
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

function clientCard(client) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "client-card";
  button.setAttribute("aria-haspopup", "dialog");
  const avatar = document.createElement("span");
  avatar.className = "client-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = initials(client.name);
  const content = document.createElement("span");
  content.className = "client-card-content";
  const name = document.createElement("strong");
  name.textContent = client.name;
  const phone = document.createElement("span");
  phone.textContent = client.phone || "Telefone não informado";
  const meta = document.createElement("span");
  meta.className = "client-card-meta";
  meta.textContent =
    client.email || `Cadastro: ${friendlyDate(client.createdAt)}`;
  content.append(name, phone, meta);
  const side = document.createElement("span");
  side.className = "client-card-side";
  const label = document.createElement("span");
  label.className = "client-tag";
  label.textContent = "Perfil";
  side.append(label);
  button.append(avatar, content, side);
  if (client.hasCustomPhoto === true) {
    void carregarFotoCartao(client.id, avatar, button);
  }
  button.addEventListener("click", () => openProfile(client.id, button));
  return button;
}

async function loadClients({ reset = false } = {}) {
  if (loading) {
    pendingReload ||= reset;
    return;
  }
  const version = queryVersion;
  const requestedQuery = query;
  if (reset) {
    limparFotosCartoes();
  }
  if (reset) {
    cursor = null;
    hasMore = false;
    list.replaceChildren();
  }
  loading = true;
  list.setAttribute("aria-busy", "true");
  moreButton.disabled = true;
  showError();
  try {
    const params = new URLSearchParams({ limit: "20" });
    if (requestedQuery) params.set("q", requestedQuery);
    if (cursor) params.set("cursor", cursor);
    const result = await apiFetch(`/api/admin/clientes?${params}`);
    if (version !== queryVersion) return;
    result.items.forEach((item) => list.append(clientCard(item)));
    cursor = result.nextCursor;
    hasMore = Boolean(result.hasMore);
    const rendered = list.children.length;
    count.textContent = requestedQuery
      ? `${rendered} resultado${rendered === 1 ? "" : "s"}`
      : `${rendered} cliente${rendered === 1 ? "" : "s"}`;
    empty.hidden = rendered > 0;
    moreButton.hidden = !hasMore;
    if (result.scanLimitReached)
      showError(
        "A busca atingiu o limite de segurança. Refine o termo ou continue pela paginação.",
      );
  } catch (error) {
    if (version === queryVersion) {
      showError(
        error.message || "Não foi possível carregar a lista de clientes.",
      );
      if (reset) empty.hidden = true;
    }
  } finally {
    loading = false;
    list.setAttribute("aria-busy", "false");
    moreButton.disabled = false;
    if (pendingReload) {
      pendingReload = false;
      void loadClients({ reset: true });
    }
  }
}

function renderAppointments(target, items) {
  target.replaceChildren();
  for (const appointment of items || []) {
    const row = document.createElement("article");
    row.className = "history-item";
    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = friendlyDate(appointment.date);
    const info = document.createElement("span");
    info.className = "history-info";
    const service = document.createElement("strong");
    service.textContent = appointment.service || "Serviço não informado";
    const detail = document.createElement("span");
    detail.textContent = `${appointment.time || "Horário não informado"} • ${appointment.status || "Agendado"}`;
    info.append(service, detail);
    row.append(date, info);
    target.append(row);
  }
}

function setExemptionStatus(message, state = "") {
  const status = $("pix-exemption-status");
  status.textContent = message;
  status.dataset.state = state;
}

async function openProfile(uid, opener) {
  activeUid = uid;
  modalReturnFocus = opener;
  const version = ++profileVersion;
  liberarFotoModal();
  $("modal-avatar").textContent = "";
  modal.hidden = false;
  modalPanel.scrollTop = 0;
  modalPanel.setAttribute("aria-busy", "true");
  document.body.style.overflow = "hidden";
  $("modal-client-name").textContent = "Carregando perfil…";
  $("profile-content").hidden = true;
  $("profile-error").hidden = true;
  $("note-status").textContent = "";
  setExemptionStatus("Carregando autorização…");
  exemption.checked = false;
  exemption.disabled = true;
  $("save-note").disabled = true;
  $("close-modal-button").focus();
  try {
    const [profile, exemptions] = await Promise.all([
      apiFetch(`/api/admin/clientes/${encodeURIComponent(uid)}`),
      apiFetch("/api/admin/isencoes-sinal-pix"),
    ]);
    if (version !== profileVersion) return;
    const client = profile.client;
    $("modal-avatar").textContent = initials(client.name);
    void carregarFotoModal(uid, version);
    $("modal-client-name").textContent = client.name;
    $("modal-client-phone").textContent =
      client.phone || "Telefone não informado";
    $("modal-client-email").textContent =
      client.email || "E-mail não informado";
    $("modal-visits").textContent = profile.historyComplete
      ? String(profile.completedCount)
      : `${profile.completedCount}+`;
    $("modal-last-visit").textContent = friendlyDate(profile.lastVisit);
    $("internal-note").value = profile.internalNote || "";
    renderAppointments($("upcoming-list"), profile.upcoming);
    renderAppointments($("client-history-list"), profile.history);
    $("upcoming-empty").hidden = profile.upcoming.length > 0;
    $("history-empty").hidden = profile.history.length > 0;
    $("history-limited").hidden = profile.historyComplete;
    const isExempt =
      Array.isArray(exemptions.clientes) && exemptions.clientes.includes(uid);
    exemption.checked = isExempt;
    exemption.disabled = false;
    $("save-note").disabled = false;
    setExemptionStatus(
      isExempt
        ? "Autorização ativa."
        : "Esta cliente precisa pagar o sinal PIX.",
    );
    $("profile-content").hidden = false;
    modalPanel.setAttribute("aria-busy", "false");
  } catch (error) {
    if (version !== profileVersion) return;
    $("modal-client-name").textContent = "Não foi possível carregar";
    $("profile-error-message").textContent =
      error.message || "Não foi possível carregar os dados desta cliente.";
    $("profile-error").hidden = false;
    modalPanel.setAttribute("aria-busy", "false");
    $("profile-content").hidden = true;
    setExemptionStatus("Não foi possível confirmar a autorização.", "error");
  }
}

function closeModal() {
  profileVersion += 1;
  liberarFotoModal();
  modal.hidden = true;
  document.body.style.overflow = "";
  activeUid = null;
  modalReturnFocus?.focus();
}

function trapFocus(event) {
  if (event.key !== "Tab") return;
  const focusable = [
    ...modal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter(
    (element) =>
      !element.closest("[hidden]") && element.getClientRects().length,
  );
  if (!focusable.length) {
    event.preventDefault();
    modal.querySelector(".client-modal").focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

$("search-form").addEventListener("submit", (event) => event.preventDefault());
search.addEventListener("input", () => {
  query = search.value.trim();
  queryVersion += 1;
  $("clear-search-button").hidden = !query;
  clearTimeout(debounce);
  debounce = setTimeout(() => void loadClients({ reset: true }), 300);
});
$("clear-search-button").addEventListener("click", () => {
  search.value = "";
  query = "";
  queryVersion += 1;
  $("clear-search-button").hidden = true;
  void loadClients({ reset: true });
  search.focus();
});
moreButton.addEventListener("click", () => void loadClients());
$("clients-retry").addEventListener(
  "click",
  () => void loadClients({ reset: true }),
);
$("close-modal-button").addEventListener("click", closeModal);
$("profile-retry").addEventListener("click", () => {
  if (activeUid) void openProfile(activeUid, modalReturnFocus);
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (modal.hidden) return;
  if (event.key === "Escape") closeModal();
  else trapFocus(event);
});
$("logout-button").addEventListener("click", async () => {
  await signOut(auth);
  location.replace("login.html");
});

$("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeUid) return;
  const button = $("save-note");
  button.disabled = true;
  $("note-status").textContent = "Salvando…";
  try {
    await apiFetch(
      `/api/admin/clientes/${encodeURIComponent(activeUid)}/observacoes`,
      {
        method: "PUT",
        body: JSON.stringify({ note: $("internal-note").value }),
      },
    );
    $("note-status").textContent = "Observação salva.";
  } catch (error) {
    $("note-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

exemption.addEventListener("change", async () => {
  if (!activeUid || exemption.disabled) return;
  const uid = activeUid;
  const desired = exemption.checked;
  exemption.disabled = true;
  setExemptionStatus("Salvando autorização…");
  await salvarIsencaoComReversao({
    uid,
    ativa: desired,
    salvar: (clienteUid, ativa) =>
      apiFetch("/api/admin/clientes/isencao-sinal-pix", {
        method: "PATCH",
        body: JSON.stringify({ clienteUid, ativa }),
      }),
    aplicarEstado: (ativa) => {
      if (activeUid === uid) exemption.checked = ativa;
    },
    informar: (message, state) => {
      if (activeUid === uid) setExemptionStatus(message, state);
    },
  });
  if (activeUid === uid) exemption.disabled = false;
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("login.html");
    return;
  }
  try {
    const usuario = await getDoc(doc(db, "usuarios", user.uid));
    const dados = usuario.exists() ? usuario.data() : null;
    if (dados?.role !== "admin" || dados?.ativo !== true) {
      $("admin-access-loading").hidden = true;
      $("admin-access-error-title").textContent = "Acesso não autorizado";
      $("admin-access-error-message").textContent =
        "Esta conta não possui permissão administrativa.";
      $("admin-access-error").hidden = false;
      document.body.dataset.accessState = "denied";
      return;
    }
    $("admin-access-loading").hidden = true;
    $("admin-clients-content").hidden = false;
    document.body.dataset.accessState = "allowed";
    await loadClients({ reset: true });
  } catch (error) {
    $("admin-access-loading").hidden = true;
    $("admin-access-error-title").textContent = "Falha ao verificar o acesso";
    $("admin-access-error-message").textContent =
      error.message || "Verifique sua conexão e tente novamente.";
    $("admin-access-error").hidden = false;
  }
});
