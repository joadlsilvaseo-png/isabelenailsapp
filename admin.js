import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  doc,
  getDoc,
  deleteDoc,
  addDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

// A função iniciarPainelAdmin é chamada diretamente no final do arquivo,
// garantindo que 'auth' e 'db' já estejam disponíveis via import.
function iniciarPainelAdmin() {
  onAuthStateChanged(auth, async (user) => {
    const listaContainer = document.getElementById("listaAgendamentos");
    if (user) {
      try {
        const userRef = doc(db, "clientes", user.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists() && userSnap.data().role === "admin") {
          console.log("Acesso Admin confirmado.");
          carregarAgendamentosDoPainel();
        } else {
          console.warn("Acesso negado: Usuário não é administrador.");
          window.location.href = "principal.html";
        }
      } catch (error) {
        console.error("Erro ao validar permissões:", error);
      }
    } else if (listaContainer) {
      listaContainer.innerHTML = `<div class="loading">Aguardando autenticação para exibir agendamentos...</div>`;
    }
  });
}

// A função iniciarPainelAdmin é chamada diretamente no final do arquivo.
async function carregarAgendamentosDoPainel() {
  const listaContainer = document.getElementById("listaAgendamentos");
  if (!listaContainer) return;

  console.log("Tentando buscar agendamentos...");

  try {
    const q = query(
      collection(db, "agendamentos"),
      where("status", "in", ["agendado", "reagendado", "confirmado"]),
    );
    const querySnapshot = await getDocs(q);

    console.log("Sucesso! Snapshot recebido. Quantidade:", querySnapshot.size);

    if (querySnapshot.empty) {
      console.warn("A coleção existe, mas está vazia.");
      listaContainer.innerHTML = `<div class="loading">Nenhum agendamento encontrado.</div>`;
      return;
    }

    // Ordenação client-side para evitar a necessidade de criar índices compostos no console do Firebase
    const agendamentosOrdenados = querySnapshot.docs.sort((a, b) => {
      const dataA = a.data().dataCriacao?.seconds || 0;
      const dataB = b.data().dataCriacao?.seconds || 0;
      return dataB - dataA;
    });

    listaContainer.innerHTML = "";

    for (const documentoOf of agendamentosOrdenados) {
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

      // JOIN MANUAL: Tenta capturar o ID tanto do novo padrão (clienteId) quanto do antigo (idCliente)
      const rawId = dados.clienteId || dados.idCliente;
      const clienteIdLimpo = rawId ? String(rawId).trim() : null;

      if (clienteIdLimpo) {
        try {
          const clienteRef = doc(db, "clientes", clienteIdLimpo);
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
          console.error(`Erro ao buscar cliente ${clienteIdLimpo}:`, err);
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

      // Botão Reagendar (Profissional)
      const rebookButton = document.createElement("button");
      rebookButton.type = "button";
      rebookButton.className = "btn-acao btn-reagendar";
      rebookButton.textContent = "Reagendar";
      rebookButton.style.backgroundColor = "#d97706";
      rebookButton.onclick = () => {
        window.location.href = `agendamento.html?id=${dados.idServico}&reagendar=${documentoOf.id}`;
      };

      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.className = "btn-acao btn-cancelar";
      cancelButton.textContent = "Cancelar";
      cancelButton.setAttribute("data-id", documentoOf.id);
      cancelButton.addEventListener("click", async () => {
        const confirmDelete = window.confirm(
          "Deseja realmente cancelar este agendamento?",
        );
        if (!confirmDelete) return;

        try {
          // AÇÃO EXPLÍCITA: Registro do motivo do cancelamento
          await updateDoc(doc(db, "agendamentos", documentoOf.id), {
            status: "cancelado_profissional",
          });

          // Grava evento de notificação para Cancelamento pelo Admin
          await addDoc(collection(db, "eventos_notificacao"), {
            tipo: "cancelamento_admin",
            clienteId: clienteIdLimpo,
            agendamentoId: documentoOf.id,
            processado: false,
            timestamp: new Date().toISOString(),
          });

          alert("Agendamento cancelado!");
          location.reload();
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
          <p style="font-size: 10px; color: #a09094; margin-top: 4px;">ID Cliente: ${clienteIdLimpo || "Não disponível"}</p>
        </div>
        <div class="agenda-obs">
          💬 ${dados.observacoes || "Sem observações"}
        </div>
        <div class="agenda-acoes"></div>
      `;

      const acoesDiv = card.querySelector(".agenda-acoes");
      acoesDiv.appendChild(finishButton);
      acoesDiv.appendChild(rebookButton);
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
  // STATUS SÓ PODE SER ALTERADO POR AÇÃO DO USUÁRIO (CLIQUE NO BOTÃO)
  // NUNCA ALTERAR EM FUNÇÕES DE RENDER OU FETCH
  // GUARD CLAUSE: Só prossegue se houver ID válido (Garantia contra chamadas automáticas)
  if (!id) return;

  const data = new Date();
  const mes = data.toISOString().substring(0, 7);

  try {
    // 1. Fluxo Financeiro (Apenas no clique)
    await addDoc(collection(db, "B.I."), {
      valor: parseFloat(valor),
      servico: servico,
      mesReferencia: mes,
      data: serverTimestamp(),
    });

    // 2. Mudança de Estado (Único local onde "realizado" é atribuído)
    await updateDoc(doc(db, "agendamentos", id), {
      status: "realizado",
    });

    alert("Receita registrada e atendimento concluído!");
    location.reload();
  } catch (error) {
    console.error("Erro ao concluir atendimento:", error);
    alert("Erro ao registrar atendimento. Verifique o console.");
  }
}

iniciarPainelAdmin(); // Inicia o painel administrativo após todas as funções estarem definidas.
