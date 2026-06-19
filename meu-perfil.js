import { auth, db } from "./firebase-config.js";
import { webhookUrl } from "./config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  updateDoc,
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
  console.log("[meu-perfil] Resolvendo nome do serviço:", {
    servico: dados.servico,
    idServico: dados.idServico,
  });

  // 1. Prioridade: Campo 'servico' gravado no agendamento (Novo fluxo)
  if (
    dados.servico &&
    typeof dados.servico === "string" &&
    dados.servico.trim()
  ) {
    console.log("[meu-perfil] ✅ Usando nome do serviço do agendamento:", dados.servico);
    return dados.servico.trim();
  }

  // 2. Prioridade: Busca dinâmica pelo idServico (Legado/Agendamentos antigos)
  if (dados.idServico) {
    try {
      const servicoRef = doc(db, "servicos", dados.idServico);
      const servicoSnap = await getDoc(servicoRef);
      if (servicoSnap.exists) {
        const nome = servicoSnap.data().nome || "Serviço Agendado";
        console.log("[meu-perfil] ✅ Usando nome do serviço do Firebase:", nome);
        return nome;
      }
    } catch (error) {
      console.error("[meu-perfil] ⚠️ Erro ao buscar nome do serviço legado:", error);
    }
  }

  // 3. Fallback final
  console.warn("[meu-perfil] ⚠️ Usando fallback - serviço não identificado");
  return "Serviço Agendado";
}

function criarCardAtivo({
  titulo,
  data,
  horario,
  id,
  idServico,
  status: statusAgendamento,
}) {
  const card = document.createElement("article");
  card.className = "perfil-card perfil-card--confirmed";

  const content = document.createElement("div");
  const title = document.createElement("p");
  title.className = "perfil-card-title";
  title.textContent = titulo;
  const status = document.createElement("p");
  status.className = "perfil-card-status";
  status.textContent =
    statusAgendamento === "reagendado" ? "Reagendado" : "Agendado";
  if (statusAgendamento === "reagendado")
    status.style.color = "var(--color-secondary)";

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

  // Container de ações para isolar cliques
  const actions = document.createElement("div");
  actions.className = "perfil-card-actions";
  actions.style.display = "flex";
  actions.style.gap = "8px";
  actions.style.marginTop = "12px";

  const rebookButton = document.createElement("button");
  rebookButton.className = "perfil-button btn-reagendar";
  rebookButton.textContent = "Reagendar";
  rebookButton.onclick = () => {
    window.location.href = `agendamento.html?id=${idServico}&reagendar=${id}`;
  };

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
      // STATUS SÓ PODE SER ALTERADO POR AÇÃO DO USUÁRIO (CLIQUE NO BOTÃO)
      // ALTERAÇÃO PARA STATUS EM VEZ DE DELETAR O REGISTRO
      await updateDoc(doc(db, "agendamentos", id), {
        status: "cancelado_cliente",
      });

      // Grava evento de notificação para Cancelamento pelo Cliente
      const eventPayloadCancelCliente = {
        tipo: "cancelamento_cliente",
        clienteId: uidBusca,
        agendamentoId: id,
        processado: false,
        timestamp: new Date().toISOString(),
      };
      await addDoc(
        collection(db, "eventos_notificacao"),
        eventPayloadCancelCliente,
      );
      // Dispara para Webhook (Redundância para WhatsApp)
      (async () => {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(eventPayloadCancelCliente),
          });
        } catch (err) {
          console.error(
            "Falha no disparo para o Webhook (Make.com - Cancelamento Cliente):",
            err,
          );
        }
      })();

      window.alert("Agendamento cancelado com sucesso!");
      window.location.reload();

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

  actions.appendChild(rebookButton);
  actions.appendChild(cancelButton);

  card.appendChild(content);
  card.appendChild(meta);
  card.appendChild(actions);

  return card;
}

function criarCardHistorico({
  titulo,
  data,
  horario,
  status: statusAgendamento,
}) {
  const card = document.createElement("article");
  card.className = "perfil-card perfil-card--history";

  let labelStatus = "Realizado";
  let corStatus = "#2a7a4a";

  if (statusAgendamento === "concluido") {
    // Novo status 'concluido'
    labelStatus = "Concluído";
    corStatus = "#2a7a4a";
  } else if (statusAgendamento.startsWith("cancelado")) {
    labelStatus =
      statusAgendamento === "cancelado_cliente"
        ? "Cancelado por Você"
        : "Cancelado pela Profissional";
    corStatus = "#b53f60";
  }

  if (statusAgendamento === "reagendado") {
    // Reagendado no histórico
    labelStatus = "Reagendado";
    corStatus = "#d97706";
  }

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
  status.textContent = labelStatus;
  status.style.color = corStatus;

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

  console.log("[meu-perfil] ===== INICIANDO BUSCA DE AGENDAMENTOS =====");
  console.log("[meu-perfil] UID do usuário logado:", uidBusca);

  try {
    const agendamentosRef = collection(db, "agendamentos");
    
    // Estratégia: Ler todos e filtrar em JS para evitar problemas com regras de segurança ou índices
    const snapshot = await getDocs(agendamentosRef);
    console.log(`[meu-perfil] Total de documentos na coleção agendamentos: ${snapshot.size}`);

    // Combina os resultados e remove duplicatas (se um agendamento tiver ambos os campos)
    const allDocs = {};
    let matchCount = 0;
    
    snapshot.forEach((doc) => {
      const dados = doc.data();
      const clienteId = dados.clienteId || dados.idCliente;
      
      console.log(`[DEBUG] Doc ID: ${doc.id}, clienteId: ${clienteId}, uidBusca: ${uidBusca}, Match: ${clienteId === uidBusca}`, dados);
      
      if (clienteId === uidBusca) {
        allDocs[doc.id] = doc;
        matchCount++;
      }
    });
    
    const mergedDocs = Object.values(allDocs);
    console.log(`[meu-perfil] Encontrados ${mergedDocs.length} agendamentos para o usuário (${matchCount} matches)`);

    if (mergedDocs.length === 0) {
      console.log("[meu-perfil] Nenhum agendamento encontrado");
      console.warn("[DEBUG] INFORMAÇÕES DE DEBUG:");
      console.warn(`   - UID do usuário: ${uidBusca}`);
      console.warn(`   - Total de agendamentos no Firebase: ${snapshot.size}`);
      console.warn("   - Verifique no Firebase Console se os agendamentos têm o campo 'clienteId' preenchido");
      console.warn("   - Lista de todos os agendamentos no Firebase:");
      snapshot.docs.forEach((doc, index) => {
        console.warn(`     [${index}]`, {
          docId: doc.id,
          clienteId: doc.data().clienteId,
          idCliente: doc.data().idCliente,
          nomeCliente: doc.data().nomeCliente,
          status: doc.data().status,
          data: doc.data().data,
        });
      });
      
      containerAgendamentos.appendChild(
        criarCardVazio("Nenhum agendamento ativo."),
      );
      containerHistorico.appendChild(
        criarCardVazio("Nenhum agendamento ativo.", true),
      );
      return;
    }
    
    console.log(`[meu-perfil] Total de agendamentos encontrados: ${mergedDocs.length}`);

    // Ordena os agendamentos (ex: por data de criação, do mais recente para o mais antigo)
    mergedDocs.sort((a, b) => {
      const dataA = a.data().dataCriacao?.seconds || 0;
      const dataB = b.data().dataCriacao?.seconds || 0;
      return dataB - dataA; // Ordem decrescente
    });

    // Itera sobre os documentos combinados e ordenados
    for (const docItem of mergedDocs) {
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

      const agendamentoData = {
        titulo: nomeServicoVisual,
        data: dados.data || "--/--",
        horario: dados.horario || "--:--",
        id: docItem.id,
        idServico: dados.idServico,
        status: dados.status || "agendado",
      };

      console.log("[meu-perfil] Agendamento processado com título:", {
        titulo: agendamentoData.titulo,
        status: agendamentoData.status,
        data: agendamentoData.data,
      });

      if (
        agendamentoData.status === "agendado" ||
        agendamentoData.status === "reagendado" ||
        agendamentoData.status === "confirmado"
      ) {
        console.log("[meu-perfil] Agendamento adicionado à seção ATIVA:", agendamentoData);
        containerAgendamentos.appendChild(criarCardAtivo(agendamentoData));
      } else if (
        agendamentoData.status === "realizado" ||
        agendamentoData.status === "cancelado_cliente" ||
        agendamentoData.status === "cancelado_profissional" ||
        agendamentoData.status === "concluido"
      ) {
        console.log("[meu-perfil] Agendamento adicionado ao HISTÓRICO:", agendamentoData);
        containerHistorico.appendChild(criarCardHistorico(agendamentoData));
      } else {
        console.warn("[DEBUG] Agendamento não foi exibido - status desconhecido:", agendamentoData);
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
    localStorage.setItem("nomeUsuario", userName);
    if (nomeCliente) nomeCliente.textContent = userName;
    if (emailCliente) emailCliente.value = user.email || "";
    if (fotoCliente)
      fotoCliente.src =
        user.photoURL || "https://www.w3schools.com/howto/img_avatar2.png";

    if (celularCliente) {
      celularCliente.value = "";
      try {
        const clienteDocRef = doc(db, "clientes", user.uid);
        const clienteDocSnap = await getDoc(clienteDocRef);

        if (clienteDocSnap.exists()) {
          const clienteData = clienteDocSnap.data();
          celularCliente.value = clienteData.telefone || "";
          console.log("[meu-perfil] Telefone carregado do Firestore:", clienteData.telefone);
        } else {
          console.warn("[meu-perfil] Documento clientes/" + user.uid + " não encontrado");
        }
      } catch (error) {
        console.error("[meu-perfil] Erro ao carregar telefone do Firestore:", error);
      }
    }

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
