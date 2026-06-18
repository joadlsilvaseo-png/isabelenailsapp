console.log("O script do Dashboard começou a rodar!"); // Teste 1

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

let myChart = null;
let cancelChart = null;
let topClientesChart = null;
let todasAsAnos = new Set();

// Proteção de Rota e Verificação de Admin
onAuthStateChanged(auth, async (user) => {
  console.log("Estado de autenticação mudou:", user); // Teste 2

  if (user) {
    console.log("Usuário logado com sucesso:", user.uid);

    try {
      // Busca o documento na coleção 'clientes' conforme solicitado
      const userRef = doc(db, "clientes", user.uid);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        const userData = userSnap.data();
        console.log("Dados do usuário:", userData);

        if (userData.role === "admin") {
          console.log("Acesso autorizado!");

          // Ocultar link para visão de cliente (Navegação Restrita)
          const backBtn = document.querySelector('a[href="principal.html"]');
          if (backBtn) backBtn.style.display = "none";

          // Se for admin, remove a tela de loading e carrega os dados
          const loadingScreen = document.getElementById("loading-screen");
          if (loadingScreen) loadingScreen.style.display = "none";

          initFilters();
          carregarDashboard();
        } else {
          console.error(
            "Acesso negado: O campo 'role' não é 'admin' ou não existe.",
          );
          window.location.href = "login.html";
        }
      } else {
        console.error(
          "Erro: Documento do usuário não encontrado na coleção 'clientes'.",
        );
        window.location.href = "login.html";
      }
    } catch (e) {
      console.error("Erro na autenticação:", e);
      window.location.href = "login.html";
    }
  } else {
    console.log("Nenhum usuário detectado.");
    window.location.href = "login.html";
  }
});

function initFilters() {
  const yearSelect = document.getElementById("filter-year");
  const monthSelect = document.getElementById("filter-month");

  // Listener para os filtros
  yearSelect.addEventListener("change", carregarDashboard);
  monthSelect.addEventListener("change", carregarDashboard);

  // Popular anos (do atual para trás como padrão, será atualizado com dados reais)
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= 2024; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = `${y}`;
    yearSelect.appendChild(opt);
  }
}

/**
 * Função principal que buscará os dados do B.I. filtrados
 */
async function carregarDashboard() {
  try {
    const year = document.getElementById("filter-year").value;
    const month = document.getElementById("filter-month").value;
    const label = document.getElementById("current-month-label");

    const biRef = collection(db, "B.I.");
    
    // Estratégia: Ler todos os docs e filtrar em JS para evitar problemas com índices compostos
    console.log("[dashboard] Lendo todos os dados da coleção B.I...");
    const snapshot = await getDocs(biRef);
    console.log(`[dashboard] Coleção B.I. consultada: ${snapshot.size} documentos na receita`);

    // Filtro em JavaScript
    let docsOrdenados = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Aplicar filtros conforme seleção
    if (year !== "Geral" || month !== "Geral") {
      docsOrdenados = docsOrdenados.filter((doc) => {
        const mesRef = String(doc.mesReferencia || "");
        
        if (year !== "Geral" && month === "Geral") {
          return mesRef.startsWith(year);
        } else if (year !== "Geral" && month !== "Geral") {
          const mesEsperado = `${year}-${month}`;
          return mesRef === mesEsperado;
        }
        return true;
      });
    }

    // Define label
    if (year !== "Geral" && month === "Geral") {
      label.textContent = `Período: ${year}`;
    } else if (year !== "Geral" && month !== "Geral") {
      const dataFormatada = new Date(
        year,
        parseInt(month) - 1,
      ).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      label.textContent = `Período: ${dataFormatada}`;
    } else {
      label.textContent = `Período Geral`;
    }

    console.log(`[dashboard] Documentos após filtro: ${docsOrdenados.length}`);

    let totalReceita = 0;
    let totalAtendimentos = docsOrdenados.length;
    const distribuicaoServicos = {};

    docsOrdenados.forEach((doc) => {
      const dados = typeof doc.data === 'function' ? doc.data() : doc;
      totalReceita += dados.valor || 0; // Soma o valor de cada registro

      // Agrupa para o gráfico
      const servico = dados.servico || "Outros";
      distribuicaoServicos[servico] = (distribuicaoServicos[servico] || 0) + 1;
    });
    
    console.log(`[dashboard] Receita total: R$ ${totalReceita.toFixed(2)}`);

    // Atualiza os elementos na tela
    const receitaEl = document.getElementById("valor-receita");
    const atendimentosEl = document.getElementById("total-atendimentos");

    if (receitaEl) receitaEl.innerText = `R$ ${totalReceita.toFixed(2)}`;
    if (atendimentosEl) atendimentosEl.innerText = totalAtendimentos;

    await carregarStatusEClientes(year, month);
    renderChart(distribuicaoServicos);
  } catch (error) {
    console.error("Erro ao carregar Dashboard:", error);
  }
}

async function carregarStatusEClientes(year, month) {
  try {
    const agendamentosRef = collection(db, "agendamentos");
    console.log("[dashboard] Acessando coleção agendamentos...");
    
    // Estratégia: Ler todos os docs e filtrar em JS para evitar problemas com índices compostos
    const snapshot = await getDocs(agendamentosRef);
    console.log(`[dashboard] Snapshot: ${snapshot.size} documentos encontrados na coleção agendamentos`);
    const documentos = snapshot.docs.map((docItem) => ({
      id: docItem.id,
      ...docItem.data(),
    }));

    const filtrados = documentos.filter((dados) => {
      if (!dados || !dados.data) return false;
      
      // Filtro de ano
      if (year !== "Geral") {
        const anoDocsrv = String(dados.data).split("-")[0] || "";
        if (anoDocsrv !== year) return false;
      }
      
      // Filtro de mês
      if (month !== "Geral") {
        const mesDoc = String(dados.data).split("-")[1] || "";
        if (mesDoc !== month) return false;
      }
      
      return true;
    });
    
    console.log(`[dashboard] Documentos após filtro de data: ${filtrados.length}`);

    let canceladosCount = 0;
    let agendadosCount = 0;
    let concluidosCount = 0;
    const completadosPorCliente = {};

    filtrados.forEach((dados) => {
      const status = String(dados.status || "").toLowerCase();
      const clienteId = String(dados.clienteId || dados.idCliente || "").trim();

      if (status.startsWith("cancelado")) {
        canceladosCount += 1;
      }
      if (["agendado", "reagendado", "confirmado"].includes(status)) {
        agendadosCount += 1;
      }
      if (["concluido", "realizado"].includes(status)) {
        concluidosCount += 1;
        if (clienteId) {
          completadosPorCliente[clienteId] = (completadosPorCliente[clienteId] || 0) + 1;
        }
      }
    });

    const totalOrders = filtrados.length;
    const cancelRate = totalOrders ? Math.round((canceladosCount / totalOrders) * 100) : 0;

    const cancelamentoEl = document.getElementById("valor-cancelamento");
    if (cancelamentoEl) cancelamentoEl.innerText = `${cancelRate}%`;

    renderCancelamentoChart(canceladosCount, agendadosCount, concluidosCount);

    const ranking = Object.entries(completadosPorCliente)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (ranking.length === 0) {
      renderTopClientesChart([]);
      return;
    }

    const clientesComNomes = await Promise.all(
      ranking.map(async ([clienteId]) => {
        try {
          const clienteSnap = await getDoc(doc(db, "clientes", clienteId));
          if (clienteSnap.exists()) {
            const clienteData = clienteSnap.data();
            return clienteData.nome || clienteData.displayName || clienteId;
          }
        } catch (error) {
          console.error(`Erro ao buscar cliente ${clienteId}:`, error);
        }
        return clienteId;
      }),
    );

    renderTopClientesChart(ranking, clientesComNomes);
    console.log("[dashboard] Métricas e gráficos renderizados com sucesso");
  } catch (error) {
    console.error("[dashboard] ERRO ao carregar métricas de status e top clientes:", error);
    console.error("Detalhes completos do erro:", JSON.stringify(error));
  }
}

function renderCancelamentoChart(canceladosCount, agendadosCount, concluidosCount) {
  const ctx = document.getElementById("cancelamentoChart");
  if (!ctx) return;

  if (cancelChart) {
    cancelChart.destroy();
  }

  cancelChart = new Chart(ctx.getContext("2d"), {
    type: "bar",
    data: {
      labels: ["Cancelados", "Agendados", "Concluídos"],
      datasets: [
        {
          data: [canceladosCount, agendadosCount, concluidosCount],
          backgroundColor: ["#b53f60", "#ffd9e7", "#2a7a4a"],
          borderRadius: 12,
          barThickness: 28,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          titleColor: "#FFD9E7",
          bodyColor: "#FFD9E7",
          padding: 10,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return Math.round(context.parsed.x) + " agendamentos";
            }
          }
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: {
            color: "#ffd9e7",
            font: { size: 12, weight: "500" },
            stepSize: 1,
            callback: function(value) {
              if (Number.isInteger(value)) {
                return value;
              }
            }
          },
          grid: { color: "rgba(255,255,255,0.08)" },
        },
        y: {
          ticks: { color: "#ffd9e7", font: { size: 12 } },
          grid: { display: false },
        },
      },
      layout: {
        padding: {
          top: 10,
          bottom: 10,
          left: 10,
          right: 10
        }
      }
    },
  });
}


function renderTopClientesChart(ranking, clienteNomes = []) {
  const ctx = document.getElementById("topClientesChart");
  if (!ctx) return;

  if (topClientesChart) {
    topClientesChart.destroy();
  }

  // Paleta de cores com tons de rosa e roxo (mesma lógica do gráfico de serviços)
  const colorPalette = [
    "#ff80ab",  // Rosa principal
    "#f6b8d0",  // Rosa claro
    "#f0a4c3",  // Rosa médio
    "#d47fa8",  // Rosa escuro
    "#b53f60",  // Rosa escuro forte
    "#9d1a45",  // Vermelho/rosa escuro
    "#a6577a",  // Roxo médio
    "#7c334c",  // Roxo escuro
  ];

  const labels = ranking.length
    ? ranking.map(([_, __], index) => clienteNomes[index] || `Cliente ${index + 1}`)
    : ["Sem dados"];
  const values = ranking.length ? ranking.map(([_, valor]) => valor) : [0];
  
  // Aplicar cores diferentes para cada barra
  const backgroundColor = ranking.length
    ? labels.map((_, index) => colorPalette[index % colorPalette.length])
    : ["rgba(255, 255, 255, 0.12)"];

  topClientesChart = new Chart(ctx.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Pedidos concluídos",
          data: values,
          backgroundColor,
          borderRadius: 12,
          barPercentage: 0.75,
          maxBarThickness: 60,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          titleColor: "#FFD9E7",
          bodyColor: "#FFD9E7",
          padding: 10,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return Math.round(context.parsed.y) + " pedidos";
            }
          }
        },
      },
      scales: {
        x: {
          ticks: { 
            color: "#ffd9e7",
            font: { size: 11 }
          },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#ffd9e7",
            font: { size: 12, weight: "500" },
            stepSize: 1,
            callback: function(value) {
              if (Number.isInteger(value)) {
                return value;
              }
            }
          },
          grid: { color: "rgba(255,255,255,0.08)" },
        },
      },
      layout: {
        padding: {
          top: 10,
          bottom: 10,
          left: 10,
          right: 10
        }
      }
    },
  });
}


function renderChart(dados) {
  const ctx = document.getElementById("servicesChart").getContext("2d");

  const labels = Object.keys(dados);
  const valores = Object.values(dados);

  if (myChart) {
    myChart.destroy();
  }

  if (labels.length === 0) {
    return; // Não desenha se não houver dados
  }

  const palette = {
    Alongamento: "#ff80ab",
    "Manicure Simples": "#f0c1d1",
    "ID do Serviço Inválido": "#3b1122",
    Outros: "#7c334c",
  };

  const fallbackColors = [
    "#ff80ab",
    "#f6b8d0",
    "#3b1122",
    "#7c334c",
    "#591c31",
    "#a6577a",
  ];
  const backgroundColor = labels.map(
    (label, index) =>
      palette[label] || fallbackColors[index % fallbackColors.length],
  );

  myChart = new Chart(ctx, {
    type: "pie",
    data: {
      labels: labels,
      datasets: [
        {
          data: valores,
          backgroundColor,
          borderWidth: 1,
          borderColor: "#2d0b19",
          hoverOffset: 12,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      aspectRatio: 1.2,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#FFD9E7",
            font: { family: "Urbanist", size: 14 },
            boxWidth: 14,
            padding: 16,
            usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.8)",
          titleColor: "#FFD9E7",
          bodyColor: "#FFD9E7",
          borderColor: "rgba(255,255,255,0.08)",
          borderWidth: 1,
          padding: 12,
          bodyFont: { family: "Urbanist", size: 13 },
        },
      },
    },
  });
}
