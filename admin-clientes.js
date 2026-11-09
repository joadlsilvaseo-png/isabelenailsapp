import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  doc,
  getDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { salvarIsencaoComReversao } from "./admin-clientes-state.js";
import { organizarClientes } from "./admin-clientes-listagem.mjs?v=1.0.0";

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
let query = "";
let debounce;
let queryVersion = 0;
let controladorCarregamento = null;
let clientesCarregadas = [];
let isencoesAtivas = new Set();
let filtroPix = "todos";
let limiteExibicao = 20;
let profileVersion = 0;
let activeUid = null;
let fotoModalUrl = null;
let modalReturnFocus = null;

const fotosCartoesUrls = new Map();

function imagemGoogle(url, avatar, valido) {
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return;
  const imagem = new Image();
  imagem.alt = "";
  imagem.referrerPolicy = "no-referrer";
  imagem.onload = () => {
    if (valido()) avatar.replaceChildren(imagem);
  };
  imagem.onerror = () => {};
  imagem.src = url;
}

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
  label.textContent = isencoesAtivas.has(client.id)
    ? "Isenta de PIX"
    : "Perfil";
  if (isencoesAtivas.has(client.id)) label.classList.add("client-tag--pix");
  button.dataset.clientId = client.id;
  side.append(label);
  button.append(avatar, content, side);
  if (client.hasCustomPhoto === true) {
    void carregarFotoCartao(client.id, avatar, button);
  } else {
    imagemGoogle(client.googlePhotoUrl, avatar, () => button.isConnected);
  }
  button.addEventListener("click", () => openProfile(client.id, button));
  return button;
}

function renderizarClientes({ recriar = false } = {}) {
  if (recriar) {
    limparFotosCartoes();
    list.replaceChildren();
  }

  const organizadas = organizarClientes(
    clientesCarregadas,
    isencoesAtivas,
    filtroPix === "isentas",
  );
  const quantidade = Math.min(limiteExibicao, organizadas.length);

  for (let indice = list.children.length; indice < quantidade; indice += 1) {
    list.append(clientCard(organizadas[indice]));
  }

  const rotulo =
    filtroPix === "isentas"
      ? "clientes isentas"
      : query
        ? "resultados"
        : "clientes";
  count.textContent =
    quantidade === organizadas.length
      ? `${organizadas.length} ${rotulo}`
      : `${quantidade} de ${organizadas.length} ${rotulo}`;

  empty.hidden = organizadas.length > 0;
  $("empty-state-message").textContent =
    filtroPix === "isentas"
      ? query
        ? "Nenhuma cliente isenta corresponde à pesquisa."
        : "Nenhuma cliente com isenção de sinal PIX encontrada."
      : "Tente outro termo de busca.";

  moreButton.hidden = quantidade >= organizadas.length;
}

async function loadClients({ reset = true } = {}) {
  // Busca todas as páginas antes de ordenar: a API pagina por UID, não por nome.
  const version = ++queryVersion;
  controladorCarregamento?.abort();
  const controlador = new AbortController();
  controladorCarregamento = controlador;
  const requestedQuery = query;

  if (reset) {
    limparFotosCartoes();
    list.replaceChildren();
    clientesCarregadas = [];
    limiteExibicao = 20;
  }

  count.textContent = "Organizando clientes…";
  empty.hidden = true;
  moreButton.hidden = true;
  moreButton.disabled = true;
  list.setAttribute("aria-busy", "true");
  showError();

  try {
    const isencoes = await apiFetch("/api/admin/isencoes-sinal-pix", {
      signal: controlador.signal,
    });
    if (!Array.isArray(isencoes.clientes)) {
      throw new Error("Não foi possível identificar as isenções de sinal PIX.");
    }

    const clientes = [];
    let cursorPagina = "";
    const cursoresVisitados = new Set();

    while (true) {
      if (version !== queryVersion) return;
      const params = new URLSearchParams({ limit: "50" });
      if (requestedQuery) params.set("q", requestedQuery);
      if (cursorPagina) params.set("cursor", cursorPagina);

      const resultado = await apiFetch(`/api/admin/clientes?${params}`, {
        signal: controlador.signal,
      });
      if (!Array.isArray(resultado.items)) {
        throw new Error("A resposta da listagem de clientes está incompleta.");
      }
      clientes.push(...resultado.items);
      if (!resultado.hasMore) break;

      const proximoCursor = resultado.nextCursor;
      if (
        !proximoCursor ||
        proximoCursor === cursorPagina ||
        cursoresVisitados.has(proximoCursor)
      ) {
        throw new Error(
          "A paginação de clientes não avançou. Tente novamente.",
        );
      }
      cursoresVisitados.add(proximoCursor);
      cursorPagina = proximoCursor;
    }

    if (version !== queryVersion) return;
    isencoesAtivas = new Set(isencoes.clientes);
    clientesCarregadas = clientes;
    renderizarClientes({ recriar: true });
  } catch (error) {
    if (version !== queryVersion || controlador.signal.aborted) return;
    showError(
      error.message || "Não foi possível carregar a lista de clientes.",
    );
    count.textContent = "Não foi possível carregar";
    empty.hidden = true;
  } finally {
    if (version === queryVersion) {
      controladorCarregamento = null;
      list.setAttribute("aria-busy", "false");
      moreButton.disabled = false;
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

function statusCelular(message = "", state = "") {
  const elemento = $("client-phone-status");
  elemento.textContent = message;
  elemento.dataset.state = state;
}

function normalizarCelularBrasileiro(valor) {
  let digitos = String(valor || "").replace(/\D/g, "");
  // Aceita celular nacional e número colado do WhatsApp com DDI +55.
  if (digitos.length === 13 && digitos.startsWith("55")) {
    digitos = digitos.slice(2);
  }
  // DDD + 9 dígitos de celular, iniciados pelo 9.
  if (!/^[1-9]{2}9\d{8}$/.test(digitos)) return "";
  return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
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
  $("client-phone-input").value = "";
  $("client-phone-input").disabled = true;
  $("save-client-phone").disabled = true;
  statusCelular();
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
    if (client.googlePhotoUrl) {
      imagemGoogle(
        client.googlePhotoUrl,
        $("modal-avatar"),
        () =>
          version === profileVersion &&
          activeUid === uid &&
          !modal.hidden &&
          !$("modal-avatar").querySelector('img[src^="blob:"]'),
      );
    }
    void carregarFotoModal(uid, version);
    $("modal-client-name").textContent = client.name;
    $("modal-client-phone").textContent =
      client.phone || "Telefone não informado";
    $("client-phone-input").value = client.phone || "";
    $("client-phone-input").disabled = false;
    $("save-client-phone").disabled = false;
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
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  else search.focus();
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
  controladorCarregamento?.abort();
  $("clear-search-button").hidden = !query;
  clearTimeout(debounce);
  debounce = setTimeout(() => void loadClients({ reset: true }), 300);
});
$("clear-search-button").addEventListener("click", () => {
  search.value = "";
  query = "";
  queryVersion += 1;
  controladorCarregamento?.abort();
  clearTimeout(debounce);
  $("clear-search-button").hidden = true;
  void loadClients({ reset: true });
  search.focus();
});
moreButton.addEventListener("click", () => {
  limiteExibicao += 20;
  renderizarClientes();
});

$("client-pix-filters").addEventListener("click", (event) => {
  const botao = event.target.closest("[data-pix-filter]");
  if (!botao || !event.currentTarget.contains(botao)) return;
  const filtro = botao.dataset.pixFilter;
  if (filtro !== "todos" && filtro !== "isentas") return;

  filtroPix = filtro;
  limiteExibicao = 20;
  event.currentTarget.querySelectorAll("[data-pix-filter]").forEach((item) => {
    const ativo = item.dataset.pixFilter === filtro;
    item.classList.toggle("filter-button--active", ativo);
    item.setAttribute("aria-pressed", String(ativo));
  });
  renderizarClientes({ recriar: true });
});
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

$("client-phone-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeUid) return;

  const uid = activeUid;
  const version = profileVersion;
  const input = $("client-phone-input");
  const button = $("save-client-phone");
  const telefone = normalizarCelularBrasileiro(input.value);
  if (!telefone) {
    statusCelular("Digite um celular válido com DDD e 9 dígitos.", "error");
    input.focus();
    return;
  }

  const telefoneAnterior = $("modal-client-phone").textContent;
  if (normalizarCelularBrasileiro(telefoneAnterior) === telefone) {
    statusCelular("Nenhuma alteração no celular.");
    return;
  }

  input.disabled = true;
  button.disabled = true;
  statusCelular("Salvando celular…");
  try {
    const usuario = auth.currentUser;
    if (!usuario) throw new Error("Sessão encerrada. Entre novamente.");

    // Atualiza APENAS o telefone da cliente no Firestore (sem sobrescrever perfil).
    await updateDoc(doc(db, "clientes", uid), { telefone });

    // Mantém a listagem coerente mesmo se o modal já foi fechado/trocado.
    const clienteNaLista = clientesCarregadas.find(
      (cliente) => cliente.id === uid,
    );
    if (clienteNaLista) {
      clienteNaLista.phone = telefone;
      renderizarClientes({ recriar: true });
      if (activeUid === uid && version === profileVersion && !modal.hidden) {
        modalReturnFocus =
          Array.from(list.children).find(
            (card) => card.dataset.clientId === uid,
          ) || search;
      }
    }

    if (activeUid === uid && version === profileVersion && !modal.hidden) {
      input.value = telefone;
      $("modal-client-phone").textContent = telefone;
      statusCelular("Celular salvo no Firebase.", "success");
    }
  } catch (erro) {
    if (activeUid === uid && version === profileVersion && !modal.hidden) {
      statusCelular(
        erro.message || "Não foi possível salvar o celular.",
        "error",
      );
    }
  } finally {
    if (activeUid === uid && version === profileVersion && !modal.hidden) {
      input.disabled = false;
      button.disabled = false;
    }
  }
});

$("client-phone-input").addEventListener("input", () => statusCelular());

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
  const salvo = await salvarIsencaoComReversao({
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
  if (salvo) {
    if (desired) isencoesAtivas.add(uid);
    else isencoesAtivas.delete(uid);
    renderizarClientes({ recriar: true });
    if (activeUid === uid) {
      modalReturnFocus =
        Array.from(list.children).find(
          (card) => card.dataset.clientId === uid,
        ) || document.querySelector('[data-pix-filter="isentas"]');
    }
  }
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
