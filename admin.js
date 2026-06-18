import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  orderBy,
  doc,
  getDoc,
  deleteDoc,
  addDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

function iniciarAdminQuandoFirebasePronto() {
  if (typeof auth === "undefined" || typeof db === "undefined") {
    window.requestAnimationFrame(iniciarAdminQuandoFirebasePronto);
    return;
  }

  onAuthStateChanged(auth, (user) => {
    const listaContainer = document.getElementById("listaAgendamentos");
    if (user) {
      carregarAgendamentosDoPainel();
    } else if (listaContainer) {
      listaContainer.innerHTML = `<div class="loading">Aguardando autenticação para exibir agendamentos...</div>`;
    }
  });
}

document.addEventListener("DOMContentLoaded", iniciarAdminQuandoFirebasePronto);

async function carregarAgendamentosDoPainel() {
  const listaContainer = document.getElementById("listaAgendamentos");
  if (!listaContainer) return;

  console.log("Tentando buscar agendamentos...");

  try {
    const q = query(
      collection(db, "agendamentos"),
      orderBy("dataCriacao", "desc"),
    );
    const querySnapshot = await getDocs(q);

    console.log("Sucesso! Snapshot recebido. Quantidade:", querySnapshot.size);

    if (querySnapshot.empty) {
      console.warn("A coleção existe, mas está vazia.");
      listaContainer.innerHTML = `<div class="loading">Nenhum agendamento encontrado.</div>`;
      return;
    }

    listaContainer.innerHTML = "";

    for (const documentoOf of querySnapshot.docs) {
      const dados = documentoOf.data();
      console.log("Documento encontrado:", dados);

      const horarioValido = String(dados.horario || "")
        .trim()
        .toLowerCase();
      if (
        !horarioValido ||
        horarioValido === "sem horário" ||
        horarioValido === "não selecionado" ||
        horarioValido === "não disponível"
      ) {
        continue;
      }

      let nomeCliente = "Cliente não encontrado";
      let nomeServico = "Serviço não encontrado";
      let valorServico = 0;

      const idClienteLimpo = dados.idCliente
        ? String(dados.idCliente).trim()
        : null;
      if (idClienteLimpo) {
        try {
          const clienteRef = doc(db, "clientes", idClienteLimpo);
          const clienteSnap = await getDoc(clienteRef);
          if (clienteSnap.exists()) {
            const dadosCliente = clienteSnap.data();
            nomeCliente =
              dadosCliente.nome ||
              dadosCliente.displayName ||
              dadosCliente.Name ||
              "Sem nome cadastrado";
          }
        } catch (err) {
          console.error(`Erro ao buscar cliente ${idClienteLimpo}:`, err);
        }
      }

      const idServicoLimpo = dados.idServico
        ? String(dados.idServico).trim()
        : null;
      if (idServicoLimpo) {
        try {
          const servicoRef = doc(db, "servicos", idServicoLimpo);
          const servicoSnap = await getDoc(servicoRef);
          if (servicoSnap.exists()) {
            const dadosServico = servicoSnap.data();
            nomeServico =
              dadosServico.nome ||
              dadosServico.nomeServico ||
              "Serviço sem nome";
            valorServico = dadosServico.preco || dadosServico.valor || 0;
          } else {
            console.warn(
              `O ID de serviço [${idServicoLimpo}] não existe na coleção 'servicos'.`,
            );
            nomeServico = "ID do Serviço Inválido";
          }
        } catch (err) {
          console.error(`Erro ao buscar serviço ${idServicoLimpo}:`, err);
          nomeServico = "Erro de conexão";
        }
      }

      const card = document.createElement("div");
      card.className = "item-agendamento";

      // Botão Concluir Atendimento
      const finishButton = document.createElement("button");
      finishButton.type = "button";
      finishButton.className = "btn-acao btn-concluir";
      finishButton.textContent = "Concluir Atendimento";
      finishButton.addEventListener("click", () =>
        concluirAtendimento(documentoOf.id, valorServico, nomeServico),
      );

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "btn-acao btn-cancelar";
      cancelButton.textContent = "Cancelar Agendamento";
      cancelButton.setAttribute("data-id", documentoOf.id);
      cancelButton.addEventListener("click", async () => {
        const confirmDelete = window.confirm(
          "Deseja realmente cancelar este agendamento?",
        );
        if (!confirmDelete) return;

        try {
          await deleteDoc(doc(db, "agendamentos", documentoOf.id));
          card.remove();
          console.log(`Agendamento ${documentoOf.id} cancelado com sucesso.`);
        } catch (error) {
          console.error("Erro ao cancelar agendamento:", error);
          window.alert(
            "Não foi possível cancelar o agendamento. Tente novamente.",
          );
        }
      });

      card.innerHTML = `
        <div class="agenda-tempo">
          <span>📅 ${dados.data || "Sem data"}</span>
          <span>⏰ ${dados.horario || "Sem horário"}</span>
        </div>
        <div class="agenda-detalhes">
          <h4>${nomeCliente}</h4>
          <p style="font-size: 14px; color: #581C2F; font-weight: 500; margin-top: 6px;">💅 ${nomeServico}</p>
          <p style="font-size: 10px; color: #a09094; margin-top: 4px;">ID Cliente: ${dados.idCliente}</p>
        </div>
        <div class="agenda-obs">
          💬 ${dados.observacoes || "Sem observações"}
        </div>
        <div class="agenda-acoes"></div>
      `;

      const acoesDiv = card.querySelector(".agenda-acoes");
      acoesDiv.appendChild(finishButton);
      acoesDiv.appendChild(cancelButton);
      listaContainer.appendChild(card);
    }
  } catch (error) {
    console.error("[Admin Error] Falha ao listar agendamentos:", error);
    listaContainer.innerHTML = `<div class="loading" style="color: red;">Erro ao acessar o banco de dados.</div>`;
  }
}

/**
 * Registra a receita na coleção B.I. e marca o agendamento como concluído
 */
async function concluirAtendimento(id, valor, servico) {
  const data = new Date();
  const mes = data.toISOString().substring(0, 7);

  try {
    // 1. Adiciona o registro financeiro na coleção B.I.
    await addDoc(collection(db, "B.I."), {
      valor: parseFloat(valor),
      servico: servico,
      mesReferencia: mes,
      data: serverTimestamp(),
    });

    // 2. Atualiza o status do agendamento
    await updateDoc(doc(db, "agendamentos", id), { status: "concluido" });

    alert("Receita registrada e atendimento concluído!");
    location.reload();
  } catch (error) {
    console.error("Erro ao concluir atendimento:", error);
    alert("Erro ao registrar atendimento. Verifique o console.");
  }
}
