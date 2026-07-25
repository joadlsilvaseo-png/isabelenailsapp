import { auth, db } from "./firebase-config.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

/* ============================================================
   ESTADO
   ============================================================ */

let todosAgendamentos = [];

let evolutionChart = null;
let servicesChart = null;
let statusChart = null;
let clientsChart = null;

let carregamentoEmAndamento = false;

/* ============================================================
   ELEMENTOS
   ============================================================ */

const elements = {};

function carregarElementos() {
  elements.body = document.body;

  elements.accessLoading = document.getElementById(
    "dashboard-access-loading",
  );

  elements.accessError = document.getElementById(
    "dashboard-access-error",
  );

  elements.accessErrorTitle = document.getElementById(
    "dashboard-access-error-title",
  );

  elements.accessErrorMessage = document.getElementById(
    "dashboard-access-error-message",
  );

  elements.content = document.getElementById(
    "dashboard-content",
  );

  elements.refreshButton = document.getElementById(
    "dashboard-refresh-button",
  );

  elements.periodFilter = document.getElementById(
    "dashboard-period-filter",
  );

  elements.periodLabel = document.getElementById(
    "dashboard-period-label",
  );

  elements.updateLabel = document.getElementById(
    "dashboard-update-label",
  );

  elements.revenue = document.getElementById(
    "dashboard-revenue",
  );

  elements.completed = document.getElementById(
    "dashboard-completed",
  );

  elements.averageTicket = document.getElementById(
    "dashboard-average-ticket",
  );

  elements.cancellationRate = document.getElementById(
    "dashboard-cancellation-rate",
  );

  elements.dataLoading = document.getElementById(
    "dashboard-data-loading",
  );

  elements.dataError = document.getElementById(
    "dashboard-data-error",
  );

  elements.retryButton = document.getElementById(
    "dashboard-retry-button",
  );

  elements.dataSections = document.getElementById(
    "dashboard-data-sections",
  );

  elements.topClients = document.getElementById(
    "dashboard-top-clients",
  );

  elements.topClientsEmpty = document.getElementById(
    "dashboard-top-clients-empty",
  );

  elements.busiestDay = document.getElementById(
    "dashboard-busiest-day",
  );

  elements.busiestTime = document.getElementById(
    "dashboard-busiest-time",
  );

  elements.topService = document.getElementById(
    "dashboard-top-service",
  );
}

/* ============================================================
   UTILITÁRIOS
   ============================================================ */

function escaparHTML(valor) {
  return String(valor ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizarTexto(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function obterPrimeiroValor(
  dados,
  campos,
  fallback = "",
) {
  for (const campo of campos) {
    const valor = dados?.[campo];

    if (
      valor !== undefined &&
      valor !== null &&
      String(valor).trim() !== ""
    ) {
      return valor;
    }
  }

  return fallback;
}

function normalizarStatus(status) {
  return normalizarTexto(
    status || "agendado",
  )
    .replace("concluído", "concluido")
    .replace(
      "cancelado pela cliente",
      "cancelado_cliente",
    )
    .replace(
      "cancelado pela profissional",
      "cancelado_profissional",
    );
}

function obterGrupoStatus(status) {
  const statusNormalizado =
    normalizarStatus(status);

  if (statusNormalizado === "agendado") {
    return "agendados";
  }

  if (
    statusNormalizado === "confirmado" ||
    statusNormalizado === "reagendado"
  ) {
    return "confirmados";
  }

  if (
    statusNormalizado === "concluido" ||
    statusNormalizado === "realizado"
  ) {
    return "concluidos";
  }

  if (
    statusNormalizado.startsWith(
      "cancelado",
    )
  ) {
    return "cancelados";
  }

  return "agendados";
}

function obterNomeCliente(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      [
        "nomeCliente",
        "clienteNome",
        "nome",
        "cliente",
      ],
      "Cliente",
    ),
  ).trim();
}

function obterServico(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      [
        "servico",
        "nomeServico",
        "servicoNome",
      ],
      "Serviço não informado",
    ),
  ).trim();
}

function obterHorario(dados) {
  return String(
    obterPrimeiroValor(
      dados,
      ["horario", "hora"],
      "",
    ),
  ).trim();
}

function obterChaveCliente(dados) {
  const identificador =
    obterPrimeiroValor(
      dados,
      [
        "clienteId",
        "idCliente",
        "userId",
        "uidCliente",
      ],
      "",
    );

  if (identificador) {
    return `id:${String(
      identificador,
    ).trim()}`;
  }

  const email = normalizarTexto(
    obterPrimeiroValor(
      dados,
      [
        "emailCliente",
        "clienteEmail",
        "email",
      ],
      "",
    ),
  );

  if (email) {
    return `email:${email}`;
  }

  const telefone = String(
    obterPrimeiroValor(
      dados,
      [
        "telefoneCliente",
        "celularCliente",
        "clienteTelefone",
        "telefone",
        "celular",
        "whatsapp",
      ],
      "",
    ),
  ).replace(/\D/g, "");

  if (telefone) {
    return `telefone:${telefone}`;
  }

  return `nome:${normalizarTexto(
    obterNomeCliente(dados),
  )}`;
}

function converterValorMonetario(valor) {
  if (
    valor === undefined ||
    valor === null ||
    valor === ""
  ) {
    return 0;
  }

  if (typeof valor === "number") {
    return Number.isFinite(valor)
      ? valor
      : 0;
  }

  let texto = String(valor)
    .trim()
    .replace(/R\$/gi, "")
    .replace(/\s/g, "");

  if (texto.includes(",")) {
    texto = texto
      .replace(/\./g, "")
      .replace(",", ".");
  } else if (
    /^\d{1,3}(\.\d{3})+$/.test(texto)
  ) {
    texto = texto.replace(/\./g, "");
  }

  texto = texto.replace(
    /[^0-9.-]/g,
    "",
  );

  const numero = Number(texto);

  return Number.isFinite(numero)
    ? numero
    : 0;
}

function obterValorAgendamento(
  agendamento,
) {
  return converterValorMonetario(
    obterPrimeiroValor(
      agendamento,
      [
        "valorFinal",
        "precoSnapshot",
        "valor",
        "preco",
      ],
      0,
    ),
  );
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat(
    "pt-BR",
    {
      style: "currency",
      currency: "BRL",
    },
  ).format(valor || 0);
}

function formatarQuantidade(
  quantidade,
  singular,
  plural,
) {
  return quantidade === 1
    ? `1 ${singular}`
    : `${quantidade} ${plural}`;
}

/* ============================================================
   DATAS E PERÍODOS
   ============================================================ */

function converterParaData(valor) {
  if (!valor) {
    return null;
  }

  if (
    typeof valor?.toDate === "function"
  ) {
    const dataTimestamp =
      valor.toDate();

    return Number.isNaN(
      dataTimestamp.getTime(),
    )
      ? null
      : dataTimestamp;
  }

  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime())
      ? null
      : new Date(valor);
  }

  const texto = String(valor).trim();

  if (!texto) {
    return null;
  }

  const formatoISO = texto.match(
    /^(\d{4})-(\d{2})-(\d{2})/,
  );

  if (formatoISO) {
    return new Date(
      Number(formatoISO[1]),
      Number(formatoISO[2]) - 1,
      Number(formatoISO[3]),
    );
  }

  const formatoBrasileiro =
    texto.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/,
    );

  if (formatoBrasileiro) {
    let ano = Number(
      formatoBrasileiro[3],
    );

    if (ano < 100) {
      ano += 2000;
    }

    return new Date(
      ano,
      Number(formatoBrasileiro[2]) - 1,
      Number(formatoBrasileiro[1]),
    );
  }

  const tentativa = new Date(texto);

  return Number.isNaN(
    tentativa.getTime(),
  )
    ? null
    : tentativa;
}

function obterDataAgendamento(
  agendamento,
) {
  return converterParaData(
    obterPrimeiroValor(
      agendamento,
      [
        "data",
        "dataAgendamento",
      ],
      null,
    ),
  );
}

function normalizarInicioDia(data) {
  const resultado = new Date(data);

  resultado.setHours(0, 0, 0, 0);

  return resultado;
}

function normalizarFimDia(data) {
  const resultado = new Date(data);

  resultado.setHours(
    23,
    59,
    59,
    999,
  );

  return resultado;
}

function obterIntervaloPeriodo(periodo) {
  const hoje = new Date();

  const inicioHoje =
    normalizarInicioDia(hoje);

  const fimHoje =
    normalizarFimDia(hoje);

  if (periodo === "today") {
    return {
      inicio: inicioHoje,
      fim: fimHoje,
      rotulo: "Hoje",
    };
  }

  if (
    periodo === "last-7-days"
  ) {
    const inicio =
      new Date(inicioHoje);

    inicio.setDate(
      inicio.getDate() - 6,
    );

    return {
      inicio,
      fim: fimHoje,
      rotulo: "Últimos 7 dias",
    };
  }

  if (
    periodo === "last-30-days"
  ) {
    const inicio =
      new Date(inicioHoje);

    inicio.setDate(
      inicio.getDate() - 29,
    );

    return {
      inicio,
      fim: fimHoje,
      rotulo: "Últimos 30 dias",
    };
  }

  if (
    periodo === "current-year"
  ) {
    return {
      inicio: new Date(
        hoje.getFullYear(),
        0,
        1,
      ),

      fim: new Date(
        hoje.getFullYear(),
        11,
        31,
        23,
        59,
        59,
        999,
      ),

      rotulo:
        `Ano de ${hoje.getFullYear()}`,
    };
  }

  if (periodo === "all") {
    return {
      inicio: null,
      fim: null,
      rotulo: "Período geral",
    };
  }

  const nomeMes =
    new Intl.DateTimeFormat(
      "pt-BR",
      {
        month: "long",
        year: "numeric",
      },
    ).format(hoje);

  return {
    inicio: new Date(
      hoje.getFullYear(),
      hoje.getMonth(),
      1,
    ),

    fim: new Date(
      hoje.getFullYear(),
      hoje.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    ),

    rotulo:
      nomeMes.charAt(0).toUpperCase() +
      nomeMes.slice(1),
  };
}

function filtrarPorPeriodo(
  agendamentos,
  periodo,
) {
  const intervalo =
    obterIntervaloPeriodo(periodo);

  if (
    !intervalo.inicio ||
    !intervalo.fim
  ) {
    return [...agendamentos];
  }

  return agendamentos.filter(
    (agendamento) => {
      const data =
        obterDataAgendamento(
          agendamento,
        );

      if (!data) {
        return false;
      }

      return (
        data >= intervalo.inicio &&
        data <= intervalo.fim
      );
    },
  );
}

function obterChaveDia(data) {
  const ano = data.getFullYear();

  const mes = String(
    data.getMonth() + 1,
  ).padStart(2, "0");

  const dia = String(
    data.getDate(),
  ).padStart(2, "0");

  return `${ano}-${mes}-${dia}`;
}

function obterChaveMes(data) {
  const ano = data.getFullYear();

  const mes = String(
    data.getMonth() + 1,
  ).padStart(2, "0");

  return `${ano}-${mes}`;
}

function criarIntervaloDeDias(
  inicio,
  fim,
) {
  const dias = [];

  const cursor =
    normalizarInicioDia(inicio);

  const limite =
    normalizarInicioDia(fim);

  while (cursor <= limite) {
    dias.push(new Date(cursor));

    cursor.setDate(
      cursor.getDate() + 1,
    );
  }

  return dias;
}

/* ============================================================
   ACESSO ADMINISTRATIVO
   ============================================================ */

async function verificarAcessoAdmin(
  user,
) {
  const usuarioRef = doc(
    db,
    "usuarios",
    user.uid,
  );

  const usuarioSnap =
    await getDoc(usuarioRef);

  if (!usuarioSnap.exists()) {
    return false;
  }

  const usuarioData =
    usuarioSnap.data();

  return (
    String(
      usuarioData.role || "",
    ).toLowerCase() === "admin" &&
    usuarioData.ativo === true
  );
}

function mostrarAcessoNegado(
  titulo,
  mensagem,
) {
  elements.body.dataset.accessState =
    "denied";

  elements.accessLoading.hidden = true;
  elements.content.hidden = true;
  elements.accessError.hidden = false;

  elements.accessErrorTitle.textContent =
    titulo;

  elements.accessErrorMessage.textContent =
    mensagem;
}

function liberarConteudoAdmin() {
  elements.body.dataset.accessState =
    "allowed";

  elements.accessLoading.hidden = true;
  elements.accessError.hidden = true;
  elements.content.hidden = false;
}

/* ============================================================
   ESTADOS DOS DADOS
   ============================================================ */

function mostrarCarregamentoDados() {
  elements.dataLoading.hidden = false;
  elements.dataError.hidden = true;
  elements.dataSections.hidden = true;

  elements.updateLabel.textContent =
    "Atualizando";
}

function mostrarErroDados() {
  elements.dataLoading.hidden = true;
  elements.dataError.hidden = false;
  elements.dataSections.hidden = true;

  elements.updateLabel.textContent =
    "Erro ao atualizar";
}

function mostrarDadosCarregados() {
  elements.dataLoading.hidden = true;
  elements.dataError.hidden = true;
  elements.dataSections.hidden = false;

  const horario =
    new Intl.DateTimeFormat(
      "pt-BR",
      {
        hour: "2-digit",
        minute: "2-digit",
      },
    ).format(new Date());

  elements.updateLabel.textContent =
    `Atualizado às ${horario}`;
}

/* ============================================================
   CÁLCULO DOS INDICADORES
   ============================================================ */

function calcularIndicadores(
  agendamentosFiltrados,
) {
  const concluidos =
    agendamentosFiltrados.filter(
      (agendamento) =>
        obterGrupoStatus(
          agendamento.status,
        ) === "concluidos",
    );

  const cancelados =
    agendamentosFiltrados.filter(
      (agendamento) =>
        obterGrupoStatus(
          agendamento.status,
        ) === "cancelados",
    );

  const receita = concluidos.reduce(
    (total, agendamento) =>
      total +
      obterValorAgendamento(
        agendamento,
      ),
    0,
  );

  const ticketMedio =
    concluidos.length
      ? receita / concluidos.length
      : 0;

  const taxaCancelamento =
    agendamentosFiltrados.length
      ? (
          cancelados.length /
          agendamentosFiltrados.length
        ) * 100
      : 0;

  return {
    receita,
    concluidos,
    ticketMedio,
    taxaCancelamento,
  };
}

function atualizarIndicadores(
  indicadores,
) {
  elements.revenue.textContent =
    formatarMoeda(
      indicadores.receita,
    );

  elements.completed.textContent =
    String(
      indicadores.concluidos.length,
    );

  elements.averageTicket.textContent =
    formatarMoeda(
      indicadores.ticketMedio,
    );

  elements.cancellationRate.textContent =
    `${Math.round(
      indicadores.taxaCancelamento,
    )}%`;
}

/* ============================================================
   DADOS DOS GRÁFICOS
   ============================================================ */

function criarDadosEvolucao(
  concluidos,
  periodo,
) {
  const intervalo =
    obterIntervaloPeriodo(periodo);

  if (periodo === "today") {
    const horas = Array.from(
      { length: 10 },
      (_, indice) => indice + 9,
    );

    const itens = horas.map(
      (hora) => ({
        chave:
          `${String(hora).padStart(
            2,
            "0",
          )}:00`,

        rotulo:
          `${String(hora).padStart(
            2,
            "0",
          )}h`,

        receita: 0,
        atendimentos: 0,
      }),
    );

    const mapa = new Map(
      itens.map(
        (item) => [
          item.chave,
          item,
        ],
      ),
    );

    concluidos.forEach(
      (agendamento) => {
        const horario =
          obterHorario(agendamento);

        const match =
          horario.match(
            /^(\d{1,2}):/,
          );

        if (!match) {
          return;
        }

        const hora =
          Number(match[1]);

        const chave =
          `${String(hora).padStart(
            2,
            "0",
          )}:00`;

        const item =
          mapa.get(chave);

        if (!item) {
          return;
        }

        item.atendimentos += 1;

        item.receita +=
          obterValorAgendamento(
            agendamento,
          );
      },
    );

    return itens;
  }

  if (
    periodo === "last-7-days" ||
    periodo === "last-30-days" ||
    periodo === "current-month"
  ) {
    const dias =
      criarIntervaloDeDias(
        intervalo.inicio,
        intervalo.fim,
      );

    const itens = dias.map(
      (data) => ({
        chave:
          obterChaveDia(data),

        rotulo:
          new Intl.DateTimeFormat(
            "pt-BR",
            {
              day: "2-digit",
              month: "2-digit",
            },
          ).format(data),

        receita: 0,
        atendimentos: 0,
      }),
    );

    const mapa = new Map(
      itens.map(
        (item) => [
          item.chave,
          item,
        ],
      ),
    );

    concluidos.forEach(
      (agendamento) => {
        const data =
          obterDataAgendamento(
            agendamento,
          );

        if (!data) {
          return;
        }

        const item = mapa.get(
          obterChaveDia(data),
        );

        if (!item) {
          return;
        }

        item.atendimentos += 1;

        item.receita +=
          obterValorAgendamento(
            agendamento,
          );
      },
    );

    return itens;
  }

  if (
    periodo === "current-year"
  ) {
    const ano =
      new Date().getFullYear();

    const itens = Array.from(
      { length: 12 },
      (_, mes) => {
        const data =
          new Date(ano, mes, 1);

        return {
          chave:
            obterChaveMes(data),

          rotulo:
            new Intl.DateTimeFormat(
              "pt-BR",
              {
                month: "short",
              },
            )
              .format(data)
              .replace(".", ""),

          receita: 0,
          atendimentos: 0,
        };
      },
    );

    const mapa = new Map(
      itens.map(
        (item) => [
          item.chave,
          item,
        ],
      ),
    );

    concluidos.forEach(
      (agendamento) => {
        const data =
          obterDataAgendamento(
            agendamento,
          );

        if (!data) {
          return;
        }

        const item = mapa.get(
          obterChaveMes(data),
        );

        if (!item) {
          return;
        }

        item.atendimentos += 1;

        item.receita +=
          obterValorAgendamento(
            agendamento,
          );
      },
    );

    return itens;
  }

  const mapaMeses = new Map();

  concluidos.forEach(
    (agendamento) => {
      const data =
        obterDataAgendamento(
          agendamento,
        );

      if (!data) {
        return;
      }

      const chave =
        obterChaveMes(data);

      if (
        !mapaMeses.has(chave)
      ) {
        mapaMeses.set(
          chave,
          {
            chave,

            rotulo:
              new Intl.DateTimeFormat(
                "pt-BR",
                {
                  month: "short",
                  year: "2-digit",
                },
              )
                .format(data)
                .replace(".", ""),

            receita: 0,
            atendimentos: 0,
          },
        );
      }

      const item =
        mapaMeses.get(chave);

      item.atendimentos += 1;

      item.receita +=
        obterValorAgendamento(
          agendamento,
        );
    },
  );

  const itens = Array.from(
    mapaMeses.values(),
  ).sort(
    (a, b) =>
      a.chave.localeCompare(
        b.chave,
      ),
  );

  return itens.length
    ? itens
    : [
        {
          chave: "sem-dados",
          rotulo: "Sem dados",
          receita: 0,
          atendimentos: 0,
        },
      ];
}

function criarRankingServicos(
  concluidos,
) {
  const mapa = new Map();

  concluidos.forEach(
    (agendamento) => {
      const servico =
        obterServico(agendamento);

      mapa.set(
        servico,
        (mapa.get(servico) || 0) + 1,
      );
    },
  );

  return Array.from(
    mapa.entries(),
  )
    .map(
      ([nome, quantidade]) => ({
        nome,
        quantidade,
      }),
    )
    .sort(
      (a, b) =>
        b.quantidade -
        a.quantidade,
    )
    .slice(0, 6);
}

function criarDistribuicaoStatus(
  agendamentos,
) {
  const contadores = {
    agendados: 0,
    confirmados: 0,
    concluidos: 0,
    cancelados: 0,
  };

  agendamentos.forEach(
    (agendamento) => {
      const grupo =
        obterGrupoStatus(
          agendamento.status,
        );

      if (
        grupo in contadores
      ) {
        contadores[grupo] += 1;
      }
    },
  );

  return contadores;
}

function criarPerfilClientes(
  concluidosDoPeriodo,
) {
  const totaisHistoricos =
    new Map();

  todosAgendamentos
    .filter(
      (agendamento) =>
        obterGrupoStatus(
          agendamento.status,
        ) === "concluidos",
    )
    .forEach(
      (agendamento) => {
        const chave =
          obterChaveCliente(
            agendamento,
          );

        totaisHistoricos.set(
          chave,
          (
            totaisHistoricos.get(
              chave,
            ) || 0
          ) + 1,
        );
      },
    );

  const clientesDoPeriodo =
    new Map();

  concluidosDoPeriodo.forEach(
    (agendamento) => {
      const chave =
        obterChaveCliente(
          agendamento,
        );

      if (
        !clientesDoPeriodo.has(
          chave,
        )
      ) {
        clientesDoPeriodo.set(
          chave,
          agendamento,
        );
      }
    },
  );

  let novas = 0;
  let recorrentes = 0;

  clientesDoPeriodo.forEach(
    (_, chave) => {
      if (
        (
          totaisHistoricos.get(
            chave,
          ) || 0
        ) >= 2
      ) {
        recorrentes += 1;
      } else {
        novas += 1;
      }
    },
  );

  return {
    novas,
    recorrentes,
  };
}

function criarRankingClientes(
  concluidos,
) {
  const mapa = new Map();

  concluidos.forEach(
    (agendamento) => {
      const chave =
        obterChaveCliente(
          agendamento,
        );

      if (!mapa.has(chave)) {
        mapa.set(
          chave,
          {
            nome:
              obterNomeCliente(
                agendamento,
              ),

            quantidade: 0,
            receita: 0,
          },
        );
      }

      const cliente =
        mapa.get(chave);

      cliente.quantidade += 1;

      cliente.receita +=
        obterValorAgendamento(
          agendamento,
        );
    },
  );

  return Array.from(
    mapa.values(),
  )
    .sort(
      (a, b) => {
        if (
          b.quantidade !==
          a.quantidade
        ) {
          return (
            b.quantidade -
            a.quantidade
          );
        }

        return (
          b.receita -
          a.receita
        );
      },
    )
    .slice(0, 5);
}

function obterItemMaisFrequente(
  mapa,
) {
  return (
    Array.from(
      mapa.entries(),
    ).sort(
      (a, b) => b[1] - a[1],
    )[0] || null
  );
}

function calcularDestaques(
  agendamentosFiltrados,
  concluidos,
) {
  const agendamentosValidos =
    agendamentosFiltrados.filter(
      (agendamento) =>
        obterGrupoStatus(
          agendamento.status,
        ) !== "cancelados",
    );

  const dias = new Map();
  const horarios = new Map();
  const servicos = new Map();

  agendamentosValidos.forEach(
    (agendamento) => {
      const data =
        obterDataAgendamento(
          agendamento,
        );

      if (data) {
        const nomeDia =
          new Intl.DateTimeFormat(
            "pt-BR",
            {
              weekday: "long",
            },
          ).format(data);

        const rotuloDia =
          nomeDia
            .charAt(0)
            .toUpperCase() +
          nomeDia.slice(1);

        dias.set(
          rotuloDia,
          (
            dias.get(
              rotuloDia,
            ) || 0
          ) + 1,
        );
      }

      const horario =
        obterHorario(agendamento);

      if (horario) {
        horarios.set(
          horario,
          (
            horarios.get(
              horario,
            ) || 0
          ) + 1,
        );
      }
    },
  );

  concluidos.forEach(
    (agendamento) => {
      const servico =
        obterServico(agendamento);

      servicos.set(
        servico,
        (
          servicos.get(
            servico,
          ) || 0
        ) + 1,
      );
    },
  );

  return {
    diaMaisMovimentado:
      obterItemMaisFrequente(
        dias,
      ),

    horarioMaisProcurado:
      obterItemMaisFrequente(
        horarios,
      ),

    servicoMaisRealizado:
      obterItemMaisFrequente(
        servicos,
      ),
  };
}

/* ============================================================
   GRÁFICOS
   ============================================================ */

function configurarChartJS() {
  if (
    typeof Chart === "undefined"
  ) {
    throw new Error(
      "Chart.js não foi carregado.",
    );
  }

  Chart.defaults.font.family =
    "Poppins, sans-serif";

  Chart.defaults.color =
    "#8a5a6a";
}

function renderizarGraficoEvolucao(
  concluidos,
  periodo,
) {
  const canvas =
    document.getElementById(
      "dashboard-evolution-chart",
    );

  if (!canvas) {
    return;
  }

  if (evolutionChart) {
    evolutionChart.destroy();
  }

  const dados =
    criarDadosEvolucao(
      concluidos,
      periodo,
    );

  evolutionChart = new Chart(
    canvas,
    {
      type: "line",

      data: {
        labels: dados.map(
          (item) => item.rotulo,
        ),

        datasets: [
          {
            label: "Receita",

            data: dados.map(
              (item) =>
                item.receita,
            ),

            borderColor:
              "#7c334c",

            backgroundColor:
              "rgba(124, 51, 76, 0.12)",

            pointBackgroundColor:
              "#7c334c",

            pointRadius: 3,

            pointHoverRadius: 5,

            borderWidth: 2,

            tension: 0.35,

            fill: true,

            yAxisID: "yRevenue",
          },

          {
            label: "Atendimentos",

            data: dados.map(
              (item) =>
                item.atendimentos,
            ),

            borderColor:
              "#a8617b",

            backgroundColor:
              "rgba(168, 97, 123, 0.08)",

            pointBackgroundColor:
              "#a8617b",

            pointRadius: 3,

            pointHoverRadius: 5,

            borderWidth: 2,

            tension: 0.35,

            yAxisID:
              "yAppointments",
          },
        ],
      },

      options: {
        responsive: true,

        maintainAspectRatio:
          false,

        interaction: {
          mode: "index",
          intersect: false,
        },

        plugins: {
          legend: {
            position: "bottom",

            labels: {
              usePointStyle: true,
              boxWidth: 8,
              padding: 14,

              font: {
                size: 9,
              },
            },
          },

          tooltip: {
            callbacks: {
              label(context) {
                if (
                  context.dataset
                    .yAxisID ===
                  "yRevenue"
                ) {
                  return ` Receita: ${formatarMoeda(
                    context.parsed.y,
                  )}`;
                }

                return ` Atendimentos: ${Math.round(
                  context.parsed.y,
                )}`;
              },
            },
          },
        },

        scales: {
          x: {
            grid: {
              display: false,
            },

            ticks: {
              font: {
                size: 8,
              },

              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
            },
          },

          yRevenue: {
            beginAtZero: true,

            position: "left",

            grid: {
              color:
                "rgba(89, 28, 49, 0.06)",
            },

            ticks: {
              font: {
                size: 8,
              },

              callback(value) {
                return new Intl.NumberFormat(
                  "pt-BR",
                  {
                    notation:
                      "compact",

                    compactDisplay:
                      "short",
                  },
                ).format(value);
              },
            },
          },

          yAppointments: {
            beginAtZero: true,

            position: "right",

            grid: {
              drawOnChartArea:
                false,
            },

            ticks: {
              precision: 0,
              stepSize: 1,

              font: {
                size: 8,
              },
            },
          },
        },
      },
    },
  );
}

function renderizarGraficoServicos(
  ranking,
) {
  const canvas =
    document.getElementById(
      "dashboard-services-chart",
    );

  if (!canvas) {
    return;
  }

  if (servicesChart) {
    servicesChart.destroy();
  }

  const dados = ranking.length
    ? ranking
    : [
        {
          nome: "Sem dados",
          quantidade: 0,
        },
      ];

  servicesChart = new Chart(
    canvas,
    {
      type: "bar",

      data: {
        labels: dados.map(
          (item) => item.nome,
        ),

        datasets: [
          {
            label:
              "Atendimentos concluídos",

            data: dados.map(
              (item) =>
                item.quantidade,
            ),

            backgroundColor: [
              "#7c334c",
              "#934761",
              "#a8617b",
              "#c88da3",
              "#ddb0c0",
              "#f0c1d1",
            ],

            borderRadius: 9,

            borderSkipped: false,

            maxBarThickness: 28,
          },
        ],
      },

      options: {
        indexAxis: "y",

        responsive: true,

        maintainAspectRatio:
          false,

        plugins: {
          legend: {
            display: false,
          },

          tooltip: {
            callbacks: {
              label(context) {
                const quantidade =
                  Math.round(
                    context.parsed.x,
                  );

                return formatarQuantidade(
                  quantidade,
                  "atendimento",
                  "atendimentos",
                );
              },
            },
          },
        },

        scales: {
          x: {
            beginAtZero: true,

            grid: {
              color:
                "rgba(89, 28, 49, 0.06)",
            },

            ticks: {
              precision: 0,
              stepSize: 1,

              font: {
                size: 8,
              },
            },
          },

          y: {
            grid: {
              display: false,
            },

            ticks: {
              font: {
                size: 8,
              },

              callback(value) {
                const label =
                  this.getLabelForValue(
                    value,
                  );

                return label.length > 22
                  ? `${label.slice(
                      0,
                      21,
                    )}…`
                  : label;
              },
            },
          },
        },
      },
    },
  );
}

function renderizarGraficoStatus(
  contadores,
) {
  const canvas =
    document.getElementById(
      "dashboard-status-chart",
    );

  if (!canvas) {
    return;
  }

  if (statusChart) {
    statusChart.destroy();
  }

  const valores = [
    contadores.agendados,
    contadores.confirmados,
    contadores.concluidos,
    contadores.cancelados,
  ];

  const possuiDados =
    valores.some(
      (valor) => valor > 0,
    );

  statusChart = new Chart(
    canvas,
    {
      type: "doughnut",

      data: {
        labels: possuiDados
          ? [
              "Agendados",
              "Confirmados",
              "Concluídos",
              "Cancelados",
            ]
          : ["Sem dados"],

        datasets: [
          {
            data: possuiDados
              ? valores
              : [1],

            backgroundColor:
              possuiDados
                ? [
                    "#f0c1d1",
                    "#934761",
                    "#2f855a",
                    "#b53f60",
                  ]
                : ["#eadde2"],

            borderWidth: 0,

            hoverOffset:
              possuiDados
                ? 6
                : 0,
          },
        ],
      },

      options: {
        responsive: true,

        maintainAspectRatio:
          false,

        cutout: "66%",

        plugins: {
          legend: {
            position: "bottom",

            labels: {
              usePointStyle: true,
              boxWidth: 8,
              padding: 13,

              font: {
                size: 8,
              },
            },
          },

          tooltip: {
            enabled: possuiDados,

            callbacks: {
              label(context) {
                const quantidade =
                  Number(
                    context.raw,
                  ) || 0;

                return ` ${formatarQuantidade(
                  quantidade,
                  "agendamento",
                  "agendamentos",
                )}`;
              },
            },
          },
        },
      },
    },
  );
}

function renderizarGraficoClientes(
  perfil,
) {
  const canvas =
    document.getElementById(
      "dashboard-clients-chart",
    );

  if (!canvas) {
    return;
  }

  if (clientsChart) {
    clientsChart.destroy();
  }

  const valores = [
    perfil.novas,
    perfil.recorrentes,
  ];

  const possuiDados =
    valores.some(
      (valor) => valor > 0,
    );

  clientsChart = new Chart(
    canvas,
    {
      type: "doughnut",

      data: {
        labels: possuiDados
          ? [
              "Clientes novas",
              "Clientes recorrentes",
            ]
          : ["Sem dados"],

        datasets: [
          {
            data: possuiDados
              ? valores
              : [1],

            backgroundColor:
              possuiDados
                ? [
                    "#f0c1d1",
                    "#7c334c",
                  ]
                : ["#eadde2"],

            borderWidth: 0,

            hoverOffset:
              possuiDados
                ? 6
                : 0,
          },
        ],
      },

      options: {
        responsive: true,

        maintainAspectRatio:
          false,

        cutout: "66%",

        plugins: {
          legend: {
            position: "bottom",

            labels: {
              usePointStyle: true,
              boxWidth: 8,
              padding: 13,

              font: {
                size: 8,
              },
            },
          },

          tooltip: {
            enabled: possuiDados,

            callbacks: {
              label(context) {
                const quantidade =
                  Number(
                    context.raw,
                  ) || 0;

                return ` ${formatarQuantidade(
                  quantidade,
                  "cliente",
                  "clientes",
                )}`;
              },
            },
          },
        },
      },
    },
  );
}

/* ============================================================
   RANKING E DESTAQUES
   ============================================================ */

function renderizarRankingClientes(
  ranking,
) {
  if (!ranking.length) {
    elements.topClients.innerHTML =
      "";

    elements.topClients.hidden =
      true;

    elements.topClientsEmpty.hidden =
      false;

    return;
  }

  elements.topClientsEmpty.hidden =
    true;

  elements.topClients.hidden =
    false;

  elements.topClients.innerHTML =
    ranking
      .map(
        (cliente, indice) => `
          <article class="dashboard-client-ranking-item">

            <span class="dashboard-client-ranking-position">
              ${indice + 1}º
            </span>

            <div class="dashboard-client-ranking-info">

              <strong>
                ${escaparHTML(
                  cliente.nome,
                )}
              </strong>

              <span>
                ${formatarQuantidade(
                  cliente.quantidade,
                  "atendimento concluído",
                  "atendimentos concluídos",
                )}
              </span>

            </div>

            <span class="dashboard-client-ranking-value">
              ${escaparHTML(
                formatarMoeda(
                  cliente.receita,
                ),
              )}
            </span>

          </article>
        `,
      )
      .join("");
}

function renderizarDestaques(
  destaques,
) {
  if (
    destaques.diaMaisMovimentado
  ) {
    const [dia, quantidade] =
      destaques.diaMaisMovimentado;

    elements.busiestDay.textContent =
      `${dia} · ${formatarQuantidade(
        quantidade,
        "agendamento",
        "agendamentos",
      )}`;
  } else {
    elements.busiestDay.textContent =
      "Sem dados";
  }

  if (
    destaques.horarioMaisProcurado
  ) {
    const [horario, quantidade] =
      destaques.horarioMaisProcurado;

    elements.busiestTime.textContent =
      `${horario} · ${formatarQuantidade(
        quantidade,
        "agendamento",
        "agendamentos",
      )}`;
  } else {
    elements.busiestTime.textContent =
      "Sem dados";
  }

  if (
    destaques.servicoMaisRealizado
  ) {
    const [servico, quantidade] =
      destaques.servicoMaisRealizado;

    elements.topService.textContent =
      `${servico} · ${formatarQuantidade(
        quantidade,
        "atendimento",
        "atendimentos",
      )}`;
  } else {
    elements.topService.textContent =
      "Sem dados";
  }
}

/* ============================================================
   CARREGAMENTO PRINCIPAL
   ============================================================ */

async function carregarDashboard() {
  if (carregamentoEmAndamento) {
    return;
  }

  carregamentoEmAndamento = true;

  mostrarCarregamentoDados();

  if (elements.refreshButton) {
    elements.refreshButton.disabled =
      true;
  }

  try {
    const snapshot = await getDocs(
      collection(
        db,
        "agendamentos",
      ),
    );

    todosAgendamentos =
      snapshot.docs.map(
        (documento) => ({
          id: documento.id,
          ...documento.data(),
        }),
      );

    const periodo =
      elements.periodFilter.value ||
      "current-month";

    const intervalo =
      obterIntervaloPeriodo(periodo);

    elements.periodLabel.textContent =
      intervalo.rotulo;

    const agendamentosFiltrados =
      filtrarPorPeriodo(
        todosAgendamentos,
        periodo,
      );

    const indicadores =
      calcularIndicadores(
        agendamentosFiltrados,
      );

    atualizarIndicadores(
      indicadores,
    );

    configurarChartJS();

    renderizarGraficoEvolucao(
      indicadores.concluidos,
      periodo,
    );

    const rankingServicos =
      criarRankingServicos(
        indicadores.concluidos,
      );

    renderizarGraficoServicos(
      rankingServicos,
    );

    const distribuicaoStatus =
      criarDistribuicaoStatus(
        agendamentosFiltrados,
      );

    renderizarGraficoStatus(
      distribuicaoStatus,
    );

    const perfilClientes =
      criarPerfilClientes(
        indicadores.concluidos,
      );

    renderizarGraficoClientes(
      perfilClientes,
    );

    const rankingClientes =
      criarRankingClientes(
        indicadores.concluidos,
      );

    renderizarRankingClientes(
      rankingClientes,
    );

    const destaques =
      calcularDestaques(
        agendamentosFiltrados,
        indicadores.concluidos,
      );

    renderizarDestaques(
      destaques,
    );

    mostrarDadosCarregados();
  } catch (error) {
    console.error(
      "Erro ao carregar o Dashboard:",
      error,
    );

    mostrarErroDados();
  } finally {
    carregamentoEmAndamento =
      false;

    if (elements.refreshButton) {
      elements.refreshButton.disabled =
        false;
    }
  }
}

/* ============================================================
   EVENTOS E INICIALIZAÇÃO
   ============================================================ */

function configurarEventos() {
  elements.refreshButton?.addEventListener(
    "click",
    carregarDashboard,
  );

  elements.retryButton?.addEventListener(
    "click",
    carregarDashboard,
  );

  elements.periodFilter?.addEventListener(
    "change",
    carregarDashboard,
  );
}

function iniciarPagina() {
  carregarElementos();
  configurarEventos();

  onAuthStateChanged(
    auth,
    async (user) => {
      if (!user) {
        window.location.replace(
          "login.html",
        );

        return;
      }

      try {
        const autorizado =
          await verificarAcessoAdmin(
            user,
          );

        if (!autorizado) {
          mostrarAcessoNegado(
            "Acesso não autorizado",
            "Esta conta não possui permissão para acessar o Dashboard.",
          );

          return;
        }

        liberarConteudoAdmin();

        await carregarDashboard();
      } catch (error) {
        console.error(
          "Erro ao verificar acesso administrativo:",
          error,
        );

        mostrarAcessoNegado(
          "Não foi possível verificar o acesso",
          "Verifique sua conexão e tente abrir a página novamente.",
        );
      }
    },
  );
}

if (
  document.readyState === "loading"
) {
  document.addEventListener(
    "DOMContentLoaded",
    iniciarPagina,
  );
} else {
  iniciarPagina();
}