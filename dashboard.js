console.log("O script do Dashboard começou a rodar!"); // Teste 1

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

let myChart = null;
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
    opt.textContent = `Ano: ${y}`;
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

    let q;
    const biRef = collection(db, "B.I.");

    if (year === "Geral" || month === "Geral") {
      // Se um dos filtros for Geral, ou filtramos só por ano ou pegamos tudo
      if (year !== "Geral" && month === "Geral") {
        // Filtra apenas pelo ano (mesReferencia começa com YYYY)
        q = query(
          biRef,
          where("mesReferencia", ">=", `${year}-01`),
          where("mesReferencia", "<=", `${year}-12`),
        );
        label.textContent = `Período: Todo o ano de ${year}`;
      } else {
        q = query(biRef);
        label.textContent = `Período: Geral (Todo o histórico)`;
      }
    } else {
      const mesRef = `${year}-${month}`;
      q = query(biRef, where("mesReferencia", "==", mesRef));

      const dataFormatada = new Date(
        year,
        parseInt(month) - 1,
      ).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      label.textContent = `Período: ${dataFormatada}`;
    }

    const snapshot = await getDocs(q);

    let totalReceita = 0;
    let totalAtendimentos = snapshot.size;
    const distribuicaoServicos = {};

    snapshot.forEach((doc) => {
      const dados = doc.data();
      totalReceita += dados.valor || 0; // Soma o valor de cada registro

      // Agrupa para o gráfico
      const servico = dados.servico || "Outros";
      distribuicaoServicos[servico] = (distribuicaoServicos[servico] || 0) + 1;
    });

    // Atualiza os elementos na tela
    const receitaEl = document.getElementById("valor-receita");
    const atendimentosEl = document.getElementById("total-atendimentos");

    if (receitaEl) receitaEl.innerText = `R$ ${totalReceita.toFixed(2)}`;
    if (atendimentosEl) atendimentosEl.innerText = totalAtendimentos;

    renderChart(distribuicaoServicos);
  } catch (error) {
    console.error("Erro ao carregar Dashboard:", error);
  }
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
