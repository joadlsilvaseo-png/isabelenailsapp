import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

let containerAgendamentos = null;
let containerHistorico = null;

function limparContainers() {
  if (containerAgendamentos) {
    const items = Array.from(
      containerAgendamentos.querySelectorAll(".perfil-card"),
    );
    items.forEach((item) => item.remove());
  }
  if (containerHistorico) {
    const items = Array.from(
      containerHistorico.querySelectorAll(".perfil-card"),
    );
    items.forEach((item) => item.remove());
  }
}

function parseDataString(dataString) {
  if (!dataString) return null;

  const parts = dataString.trim().split(/\s+/);
  const onlyDate = parts[0];
  const slashMatch = onlyDate.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10);
    const year = slashMatch[3]
      ? parseInt(slashMatch[3], 10)
      : new Date().getFullYear();
    return new Date(year, month - 1, day);
  }

  const dayNumber = parseInt(onlyDate, 10);
  if (Number.isNaN(dayNumber)) return null;

  const today = new Date();
  const candidate = new Date(today.getFullYear(), today.getMonth(), dayNumber);
  return candidate;
}

function isDataFuturaOuHoje(dataString) {
  const data = parseDataString(dataString);
  if (!data) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  data.setHours(0, 0, 0, 0);

  return data.getTime() >= today.getTime();
}

async function resolveNomeServicoVisual(dados) {
  // 1. Prioridade: Campo 'servico' gravado no agendamento (Novo fluxo)
  if (
    dados.servico &&
    typeof dados.servico === "string" &&
    dados.servico.trim()
  ) {
    return dados.servico.trim();
  }

  // 2. Prioridade: Busca dinâmica pelo idServico (Legado/Agendamentos antigos)
  if (dados.idServico) {
    try {
      const servicoRef = doc(db, "servicos", dados.idServico);
      const servicoSnap = await getDoc(servicoRef);
      if (servicoSnap.exists) {
        return servicoSnap.data().nome || "Serviço Agendado";
      }
    } catch (error) {
      console.error("Erro ao buscar nome do serviço legado:", error);
    }
  }

  // 3. Fallback final
  return "Serviço Agendado";
}

function criarCardAtivo({ titulo, data, horario, id }) {
  const card = document.createElement("article");
  card.className = "perfil-card perfil-card--confirmed";

  const content = document.createElement("div");
  const title = document.createElement("p");
  title.className = "perfil-card-title";
  title.textContent = titulo;
  const status = document.createElement("p");
  status.className = "perfil-card-status";
  status.textContent = "Confirmado";

  content.appendChild(title);
  content.appendChild(status);

  const meta = document.createElement("div");
  meta.className = "perfil-card-meta";
  const dateEl = document.createElement("span");
  dateEl.className = "perfil-card-date";
  dateEl.textContent = data;
  const timeEl = document.createElement("span");
  timeEl.className = "perfil-card-time";
  timeEl.textContent = horario;
  meta.appendChild(dateEl);
  meta.appendChild(timeEl);

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "perfil-button btn-cancelar";
  cancelButton.textContent = "Cancelar";
  cancelButton.addEventListener("click", async () => {
    const confirmDelete = window.confirm(
      "Deseja realmente cancelar esse agendamento?",
    );
    if (!confirmDelete) return;

    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelando...";

    try {
      await deleteDoc(doc(db, "agendamentos", id));
      window.alert("Agendamento cancelado com sucesso!");
      card.remove();

      if (
        containerAgendamentos &&
        containerAgendamentos.querySelectorAll(".perfil-card").length === 0
      ) {
        containerAgendamentos.appendChild(
          criarCardVazio("Nenhum agendamento ativo."),
        );
      }
    } catch (error) {
      console.error("Erro ao cancelar agendamento:", error);
      window.alert(
        "Não foi possível cancelar o agendamento. Tente novamente mais tarde.",
      );
      cancelButton.disabled = false;
      cancelButton.textContent = "Cancelar";
    }
  });

  card.appendChild(content);
  card.appendChild(meta);
  card.appendChild(cancelButton);

  return card;
}

function criarCardHistorico({ titulo, data, horario }) {
  const card = document.createElement("article");
  card.className = "perfil-card perfil-card--history";

  const historyRow = document.createElement("div");
  historyRow.className = "perfil-card-history-row";
  const checkbox = document.createElement("span");
  checkbox.className = "perfil-card-checkbox";
  checkbox.setAttribute("aria-hidden", "true");
  checkbox.textContent = "✓";
  const title = document.createElement("p");
  title.className = "perfil-card-title";
  title.textContent = titulo;
  historyRow.appendChild(checkbox);
  historyRow.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "perfil-card-meta";
  const dateEl = document.createElement("span");
  dateEl.className = "perfil-card-date";
  dateEl.textContent = data;
  const timeEl = document.createElement("span");
  timeEl.className = "perfil-card-time";
  timeEl.textContent = horario;
  meta.appendChild(dateEl);
  meta.appendChild(timeEl);

  const status = document.createElement("p");
  status.className = "perfil-card-status perfil-card-status--done";
  status.textContent = "Realizado";

  card.appendChild(historyRow);
  card.appendChild(meta);
  card.appendChild(status);

  return card;
}

function criarCardVazio(mensagem, historico = false) {
  const card = document.createElement("article");
  card.className = `perfil-card ${historico ? "perfil-card--history" : "perfil-card--confirmed"}`;

  const message = document.createElement("p");
  message.className = "perfil-empty-message";
  message.textContent = mensagem;

  card.appendChild(message);
  return card;
}

async function carregarAgendamentos(uid) {
  if (!containerAgendamentos || !containerHistorico) return;

  limparContainers();

  const uidBusca = String(uid || "").trim();
  if (!uidBusca) {
    console.error("UID de busca inválido em meu-perfil.js:", uid);
    containerAgendamentos.appendChild(
      criarCardVazio("Nenhum agendamento ativo."),
    );
    containerHistorico.appendChild(
      criarCardVazio("Nenhum agendamento ativo.", true),
    );
    return;
  }

  console.log("Buscando agendamentos reais para o ID logado:", uidBusca);

  try {
    const q = query(
      collection(db, "agendamentos"),
      where("idCliente", "==", uidBusca),
    );
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      containerAgendamentos.appendChild(
        criarCardVazio("Nenhum agendamento ativo."),
      );
      containerHistorico.appendChild(
        criarCardVazio("Nenhum agendamento ativo.", true),
      );
      return;
    }

    // Alterado para loop for...of para suportar o processamento assíncrono do nome do serviço
    for (const docItem of querySnapshot.docs) {
      const dados = docItem.data();

      const horarioValido = String(dados.horario || "")
        .trim()
        .toLowerCase();
      if (
        !horarioValido ||
        horarioValido === "não disponível" ||
        horarioValido === "não selecionado"
      ) {
        console.warn(
          "Agendamento ignorado por horário inválido:",
          docItem.id,
          horarioValido,
        );
        continue;
      }

      console.log("Agendamento encontrado:", dados);

      const nomeServicoVisual = await resolveNomeServicoVisual(dados);
      const dataTexto = dados.data || "Data não disponível";
      const horarioTexto = dados.horario || "Horário não disponível";

      const agendamentoData = {
        titulo: nomeServicoVisual,
        data: dataTexto,
        horario: horarioTexto,
        id: docItem.id,
      };

      if (isDataFuturaOuHoje(agendamentoData.data)) {
        containerAgendamentos.appendChild(criarCardAtivo(agendamentoData));
      } else {
        containerHistorico.appendChild(criarCardHistorico(agendamentoData));
      }
    }
  } catch (error) {
    console.error("Erro ao carregar agendamentos do Firestore:", error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const nomeCliente = document.getElementById("nome-cliente");
  const emailCliente = document.getElementById("email-cliente");
  const fotoCliente = document.getElementById("foto-cliente");
  const celularCliente = document.getElementById("celular-cliente");
  containerAgendamentos = document.getElementById("container-agendamentos");
  containerHistorico = document.getElementById("container-historico");

  const logoutButton = document.getElementById("logout-button");

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      return;
    }

    const userName = user.displayName?.trim() || "Heitor Vieira";
    if (nomeCliente) nomeCliente.textContent = userName;
    if (emailCliente) emailCliente.value = user.email || "";
    if (fotoCliente)
      fotoCliente.src =
        user.photoURL || "https://www.w3schools.com/howto/img_avatar2.png";
    if (celularCliente) celularCliente.value = "";

    if (logoutButton) {
      logoutButton.addEventListener("click", (event) => {
        event.preventDefault();
        signOut(auth)
          .then(() => {
            window.location.href = "login.html";
          })
          .catch((error) => {
            console.error("Erro ao fazer logout:", error);
            window.alert("Não foi possível sair no momento. Tente novamente.");
          });
      });
    }

    await carregarAgendamentos(user.uid);
  });
});
