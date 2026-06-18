import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  getDocs,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

let allMonthlyReports = [];

/**
 * Segurança: Verifica se o usuário é admin antes de carregar os dados
 */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  try {
    const userRef = doc(db, "clientes", user.uid);
    const userSnap = await getDoc(userRef);

    if (userSnap.exists() && userSnap.data().role === "admin") {
      const loadingScreen = document.getElementById("loading-screen");
      if (loadingScreen) loadingScreen.style.display = "none";

      await carregarHistorico();
    } else {
      console.error("Acesso negado: Usuário não é administrador.");
      window.location.href = "principal.html";
    }
  } catch (e) {
    console.error("Erro na verificação de permissões:", e);
    window.location.href = "principal.html";
  }
});

/**
 * Busca e agrupa os dados da coleção B.I.
 */
async function carregarHistorico() {
  try {
    const snapshot = await getDocs(collection(db, "B.I."));
    const reports = {};
    const availableYears = new Set();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const mesRef = data.mesReferencia; // Formato esperado: "YYYY-MM"

      if (!mesRef) return;

      const year = mesRef.substring(0, 4);
      availableYears.add(year);

      if (!reports[mesRef]) {
        reports[mesRef] = { receita: 0, atendimentos: 0 };
      }

      reports[mesRef].receita += data.valor || 0;
      reports[mesRef].atendimentos++;
    });

    // Transforma o objeto em array e ordena por mês (mais recente primeiro)
    allMonthlyReports = Object.entries(reports)
      .map(([mesRef, dados]) => ({
        mesRef,
        ...dados,
      }))
      .sort((a, b) => b.mesRef.localeCompare(a.mesRef));

    setupYearFilter(Array.from(availableYears).sort((a, b) => b - a));
    renderTable();
  } catch (error) {
    console.error("Erro ao carregar dados do histórico:", error);
  }
}

/**
 * Preenche o select de anos e adiciona o evento de filtro
 */
function setupYearFilter(years) {
  const select = document.getElementById("year-filter");
  if (!select) return;

  years.forEach((year) => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    select.appendChild(option);
  });

  select.addEventListener("change", renderTable);
}

/**
 * Renderiza as linhas da tabela filtradas pelo ano selecionado
 */
function renderTable() {
  const tableBody = document.getElementById("reports-body");
  const selectedYear = document.getElementById("year-filter").value;
  if (!tableBody) return;

  tableBody.innerHTML = "";
  const filtered = allMonthlyReports.filter((item) =>
    item.mesRef.startsWith(selectedYear),
  );

  filtered.forEach((item) => {
    const [year, month] = item.mesRef.split("-");
    const monthName = new Date(year, month - 1).toLocaleDateString("pt-BR", {
      month: "long",
    });
    const formattedMonth =
      monthName.charAt(0).toUpperCase() + monthName.slice(1) + "/" + year;

    const tr = document.createElement("tr");
    tr.innerHTML = `
            <td>${formattedMonth}</td>
            <td>R$ ${item.receita.toFixed(2).replace(".", ",")}</td>
            <td>${item.atendimentos} atendimentos</td>
        `;
    tableBody.appendChild(tr);
  });
}
