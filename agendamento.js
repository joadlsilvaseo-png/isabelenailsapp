import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  addDoc,
  updateDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

// Funções de ajuda para seleção única de data e horário
function selecionarUnico(botaoAtivo, grupo, classeAtiva) {
  grupo.forEach((botao) => {
    const ativo = botao === botaoAtivo;
    botao.classList.toggle(classeAtiva, ativo);
    botao.setAttribute("aria-pressed", String(ativo));
  });
}

function obterSelecionado(grupo, classeAtiva) {
  return grupo.find((botao) => botao.classList.contains(classeAtiva));
}

function formatarData(botaoData) {
  if (!botaoData) return "";

  return botaoData.dataset.dateLabel || botaoData.dataset.dateIso || "";
}

function obterDataIso(botaoData) {
  if (!botaoData) return null;
  return botaoData.dataset?.dateIso || null;
}

function preencherNomeClienteDoLocalStorage() {
  const nomeUsuario = localStorage.getItem("nomeUsuario");
  const nomeInput = document.getElementById("nomeCliente");
  if (nomeUsuario && nomeInput) {
    nomeInput.value = nomeUsuario;
  }
}

const timeToMins = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

const minsToTime = (m) => {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

function validarAgendamento(data, hora) {
  if (!data || !hora) return false;
  const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(data);
  const horaOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);
  return dataOk && horaOk;
}
function formatarDataIsoLocal(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");

  return `${ano}-${mes}-${dia}`;
}

function formatarDataLonga(data) {
  const texto = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).format(data);

  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function formatarMesAno(data) {
  const texto = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
  }).format(data);

  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

function formatarPrecoServico(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return "Valor a consultar";
  }

  const valorLimpo = String(valor)
    .replace(/R\$/gi, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const valorNumerico = Number(valorLimpo);

  if (!Number.isFinite(valorNumerico)) {
    return String(valor);
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(valorNumerico);
}
function converterPrecoParaNumero(valor) {
  if (valor === undefined || valor === null || valor === "") {
    return 0;
  }

  if (typeof valor === "number") {
    return Number.isFinite(valor) ? valor : 0;
  }

  let texto = String(valor).trim().replace(/R\$/gi, "").replace(/\s/g, "");

  if (texto.includes(",")) {
    texto = texto.replace(/\./g, "").replace(",", ".");
  }

  texto = texto.replace(/[^0-9.-]/g, "");

  const numero = Number(texto);

  return Number.isFinite(numero) ? numero : 0;
}
function configurarLinkVoltar(categoria) {
  const backLink = document.getElementById("agendamento-back-link");

  if (!backLink) {
    return;
  }

  const destinosPorCategoria = {
    "unhas em gel": "unhas-em-gel.html",
    manicure: "manicure.html",
    pedicure: "pedicure.html",
  };

  const categoriaNormalizada = String(categoria || "")
    .trim()
    .toLowerCase();

  backLink.href =
    destinosPorCategoria[categoriaNormalizada] ||
    "principal.html#services-title";
}

function atualizarCabecalhoData(botaoData) {
  if (!botaoData) return;

  const monthElement = document.getElementById("calendar-month-label");

  const selectedDateElement = document.getElementById("selected-date-text");

  if (monthElement) {
    monthElement.textContent = botaoData.dataset.monthLabel || "Data";
  }

  if (selectedDateElement) {
    selectedDateElement.textContent =
      botaoData.dataset.dateLabel || "Data selecionada";
  }
}

function atualizarResumoAgendamento() {
  const dataSelecionada = document.querySelector(".agendamento-date--active");

  const horarioSelecionado = document.querySelector(
    ".agendamento-time--active",
  );

  const nomeInput = document.getElementById("nomeCliente");

  const resumoData = document.getElementById("summary-date");

  const resumoHorario = document.getElementById("summary-time");

  const botaoAgendar = document.querySelector(".agendamento-button");

  if (resumoData) {
    resumoData.textContent = dataSelecionada
      ? dataSelecionada.dataset.dateLabel
      : "Escolha a data";
  }

  if (resumoHorario) {
    resumoHorario.textContent = horarioSelecionado
      ? horarioSelecionado.dataset.time || horarioSelecionado.textContent.trim()
      : "Escolha o horário";
  }

  const nomePreenchido = Boolean(nomeInput?.value?.trim());

  const prontoParaAgendar = Boolean(
    dataSelecionada && horarioSelecionado && nomePreenchido,
  );

  if (botaoAgendar) {
    botaoAgendar.disabled = !prontoParaAgendar;
    botaoAgendar.classList.toggle("is-ready", prontoParaAgendar);
  }
}
function gerarCalendarioDias(container) {
  if (!container) return;

  container.innerHTML = "";

  const weekNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

  const monthNames = [
    "Jan",
    "Fev",
    "Mar",
    "Abr",
    "Mai",
    "Jun",
    "Jul",
    "Ago",
    "Set",
    "Out",
    "Nov",
    "Dez",
  ];

  const diasAtendimento = new Set([2, 3, 4, 5, 6]);

  const dias = [];

  const hoje = new Date();
  hoje.setHours(12, 0, 0, 0);

  const hojeIso = formatarDataIsoLocal(hoje);

  const cursor = new Date(hoje);

  while (dias.length < 8) {
    if (diasAtendimento.has(cursor.getDay())) {
      const dataAtual = new Date(cursor);

      const dataIso = formatarDataIsoLocal(dataAtual);

      const botao = document.createElement("button");

      botao.type = "button";
      botao.className = "agendamento-date";

      botao.dataset.dateIso = dataIso;
      botao.dataset.dateLabel = formatarDataLonga(dataAtual);

      botao.dataset.monthLabel = formatarMesAno(dataAtual);

      botao.setAttribute("aria-pressed", "false");

      botao.setAttribute(
        "aria-label",
        `Selecionar ${formatarDataLonga(dataAtual)}`,
      );

      if (dataIso === hojeIso) {
        botao.classList.add("agendamento-date--today");
      }

      botao.innerHTML = `
        <span class="agendamento-date-label">
          ${weekNames[dataAtual.getDay()]}
        </span>

        <span class="agendamento-date-day">
          ${String(dataAtual.getDate()).padStart(2, "0")}
        </span>

        <span class="agendamento-date-month">
          ${monthNames[dataAtual.getMonth()]}
        </span>
      `;

      container.appendChild(botao);
      dias.push(botao);
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  const primeiraData = dias[0];

  if (primeiraData) {
    primeiraData.classList.add("agendamento-date--active");

    primeiraData.setAttribute("aria-pressed", "true");

    localStorage.setItem("dataAgendamento", formatarData(primeiraData));

    localStorage.setItem("dataAgendamentoISO", obterDataIso(primeiraData));

    atualizarCabecalhoData(primeiraData);
  }
}

function aguardarRedirecionamento(botao) {
  botao.textContent = "Agendando...";
  botao.disabled = true;
  botao.classList.add("agendamento-button--disabled");
}

async function carregarServicoSelecionado(serviceId) {
  const nameElement = document.getElementById("service-name");

  const durationElement = document.getElementById("service-duration");

  const priceElement = document.getElementById("service-price");

  const summaryServiceElement = document.getElementById("summary-service");

  if (!serviceId) {
    if (nameElement) {
      nameElement.textContent = "Serviço não especificado";
    }

    if (durationElement) {
      durationElement.textContent = "Duração não informada";
    }

    if (priceElement) {
      priceElement.textContent = "Valor a consultar";
    }

    return null;
  }

  try {
    const servicoRef = doc(db, "servicos", serviceId);

    const servicoSnap = await getDoc(servicoRef);

    if (!servicoSnap.exists()) {
      if (nameElement) {
        nameElement.textContent = "Serviço não encontrado";
      }

      return null;
    }

    const serviceData = servicoSnap.data();

    const nomeServico = serviceData.nome || "Serviço selecionado";

    const duracao = Number(serviceData.duracao) || 60;

    const precoFormatado = formatarPrecoServico(serviceData.preco);

    if (nameElement) {
      nameElement.textContent = nomeServico;
    }

    if (durationElement) {
      durationElement.textContent = `${duracao} min`;
    }

    if (priceElement) {
      priceElement.textContent = precoFormatado;
    }

    if (summaryServiceElement) {
      summaryServiceElement.textContent = nomeServico;
    }

    return {
      nome: nomeServico,
      duracao,
      preco: serviceData.preco,
      categoria: serviceData.categoria || "",
    };
  } catch (error) {
    console.error("Erro ao carregar serviço:", error);

    if (nameElement) {
      nameElement.textContent = "Erro ao carregar o serviço";
    }

    return null;
  }
}
function obterIntervalosBloqueadosFixos(dataIso) {
  if (!dataIso) {
    return [];
  }

  const [ano, mes, dia] = String(dataIso).split("-").map(Number);

  const data = new Date(ano, mes - 1, dia, 12, 0, 0);

  const diaSemana = data.getDay();

  /*
   * 0 = Domingo
   * 1 = Segunda
   * 2 = Terça
   * 3 = Quarta
   * 4 = Quinta
   * 5 = Sexta
   * 6 = Sábado
   */

  if (diaSemana === 2) {
    return [
      {
        start: timeToMins("09:00"),
        end: timeToMins("13:30"),
      },
    ];
  }

  if (diaSemana === 4) {
    return [
      {
        start: timeToMins("09:00"),
        end: timeToMins("12:00"),
      },
    ];
  }

  return [];
}
async function renderizarHorarios(dataIso, servicoDuracao, reagendarId = null) {
  const container = document.querySelector(".agendamento-times");

  const availabilityElement = document.getElementById("availability-status");

  if (!container || !dataIso) {
    console.error("Contêiner de horários ou data não encontrados.");

    return;
  }

  container.innerHTML = `
    <div class="agendamento-loading">
      Buscando horários disponíveis...
    </div>
  `;

  if (availabilityElement) {
    availabilityElement.textContent = "Buscando";
  }

  try {
    const consulta = query(
      collection(db, "agendamentos"),
      where("data", "==", String(dataIso).trim()),
    );

    const querySnapshot = await getDocs(consulta);

    const intervalosOcupados = [];

    const statusValidos = ["agendado", "reagendado", "confirmado"];

    querySnapshot.forEach((documento) => {
      const dados = documento.data();

      if (reagendarId && documento.id === reagendarId) {
        return;
      }

      if (!dados.horario || !statusValidos.includes(dados.status)) {
        return;
      }

      const inicio = timeToMins(dados.horario);

      const duracaoAgendada = Number(dados.duracao) || 90;

      intervalosOcupados.push({
        start: inicio,
        end: inicio + duracaoAgendada,
      });
    });

    const duracaoServico = Number(servicoDuracao) || 60;

    const [anoSelecionado, mesSelecionado, diaSelecionado] = String(dataIso)
      .split("-")
      .map(Number);

    const diaSemanaSelecionado = new Date(
      anoSelecionado,
      mesSelecionado - 1,
      diaSelecionado,
      12,
      0,
      0,
    ).getDay();

    const intervalosBloqueadosFixos = obterIntervalosBloqueadosFixos(dataIso);

    const intervalosIndisponiveis = [
      ...intervalosOcupados,
      ...intervalosBloqueadosFixos,
    ];

    const minAbertura = timeToMins("09:00");

    const minUltimoInicio = timeToMins("18:00");

    const minFechamento = timeToMins("20:00");

    const horariosManha = [];
    const horariosTarde = [];

    let quantidadeDisponivel = 0;

    for (let atual = minAbertura; atual <= minUltimoInicio; atual += 30) {
      const fimServico = atual + duracaoServico;

      if (fimServico > minFechamento) {
        continue;
      }

      const horarioTexto = minsToTime(atual);

      const bloqueadoPorRegraTerca =
        diaSemanaSelecionado === 2 &&
        (atual > timeToMins("15:30") || fimServico > timeToMins("17:30"));

      const horarioPermitidoQuartaManha =
        atual >= timeToMins("09:00") &&
        atual <= timeToMins("10:30") &&
        fimServico <= timeToMins("12:30");

      const horarioPermitidoQuartaEncaixe =
        atual >= timeToMins("11:00") &&
        atual <= timeToMins("11:30") &&
        duracaoServico <= 60 &&
        fimServico <= timeToMins("12:30");

      const horarioPermitidoQuartaTarde =
        atual >= timeToMins("13:30") &&
        atual <= timeToMins("15:30") &&
        fimServico <= timeToMins("17:30");

      const bloqueadoPorRegraQuarta =
        diaSemanaSelecionado === 3 &&
        !horarioPermitidoQuartaManha &&
        !horarioPermitidoQuartaEncaixe &&
        !horarioPermitidoQuartaTarde;

      const indisponivel =
        bloqueadoPorRegraTerca ||
        bloqueadoPorRegraQuarta ||
        intervalosIndisponiveis.some(
          (intervalo) => atual < intervalo.end && fimServico > intervalo.start,
        );

      const botao = document.createElement("button");

      botao.type = "button";
      botao.className = "agendamento-time";
      botao.textContent = horarioTexto;
      botao.dataset.time = horarioTexto;

      botao.setAttribute("aria-pressed", "false");

      if (indisponivel) {
        botao.classList.add("horario-ocupado");

        botao.disabled = true;

        botao.setAttribute("aria-disabled", "true");

        botao.setAttribute("aria-label", `${horarioTexto}, indisponível`);
      } else {
        quantidadeDisponivel += 1;

        botao.setAttribute("aria-label", `Selecionar ${horarioTexto}`);
      }

      if (atual < timeToMins("12:00")) {
        horariosManha.push(botao);
      } else {
        horariosTarde.push(botao);
      }
    }

    container.innerHTML = "";

    function criarGrupoHorario(titulo, subtitulo, horarios) {
      if (!horarios.length) return;

      const periodo = document.createElement("section");

      periodo.className = "agendamento-period";

      const heading = document.createElement("div");

      heading.className = "agendamento-period-heading";

      const title = document.createElement("strong");

      title.textContent = titulo;

      const description = document.createElement("span");

      description.textContent = subtitulo;

      const grid = document.createElement("div");

      grid.className = "agendamento-time-grid";

      horarios.forEach((horario) => {
        grid.appendChild(horario);
      });

      heading.appendChild(title);
      heading.appendChild(description);

      periodo.appendChild(heading);
      periodo.appendChild(grid);

      container.appendChild(periodo);
    }

    criarGrupoHorario("Manhã", "Das 9h às 12h", horariosManha);

    criarGrupoHorario("Tarde", "Das 12h às 18h", horariosTarde);

    if (availabilityElement) {
      availabilityElement.textContent =
        quantidadeDisponivel === 1
          ? "1 horário"
          : `${quantidadeDisponivel} horários`;
    }

    if (quantidadeDisponivel === 0) {
      container.innerHTML = `
        <div class="agendamento-time-state">
          Não há horários disponíveis nesta data.
          Escolha outro dia para continuar.
        </div>
      `;
    }

    const horarioSalvo = localStorage.getItem("horarioAgendamento");

    if (horarioSalvo) {
      const horarioValido = Array.from(
        container.querySelectorAll(".agendamento-time:not([disabled])"),
      ).find((botao) => botao.dataset.time === horarioSalvo);

      if (horarioValido) {
        const todosHorarios = Array.from(
          container.querySelectorAll(".agendamento-time"),
        );

        selecionarUnico(
          horarioValido,
          todosHorarios,
          "agendamento-time--active",
        );
      } else {
        localStorage.removeItem("horarioAgendamento");

        localStorage.removeItem("horaAgendamento");
      }
    }

    atualizarResumoAgendamento();
  } catch (error) {
    console.error("Erro ao carregar horários:", error);

    container.innerHTML = `
      <div class="agendamento-time-state">
        Não foi possível carregar os horários.
        Verifique sua conexão e tente novamente.
      </div>
    `;

    if (availabilityElement) {
      availabilityElement.textContent = "Indisponível";
    }

    atualizarResumoAgendamento();
  }
}

async function inicializarAgendamento() {
  const calendarContainer = document.querySelector(".agendamento-calendar");
  gerarCalendarioDias(calendarContainer);
  const datas = Array.from(document.querySelectorAll(".agendamento-date"));
  const botaoAgendar = document.querySelector(".agendamento-button");

  const textareaComentarios = document.querySelector("#agendamento-notes");
  const urlParams = new URLSearchParams(window.location.search);
  if (!botaoAgendar) {
    console.error("Botão agendar não encontrado no DOM!");
  }
  const serviceId = urlParams.get("id");
  const reagendarId = urlParams.get("reagendar");
  const origemAdmin = urlParams.get("origem") === "admin";

  if (!botaoAgendar || datas.length === 0 || !textareaComentarios) return;

  localStorage.removeItem("horarioAgendamento");
  localStorage.removeItem("horaAgendamento");
  const serviceInfo = await carregarServicoSelecionado(serviceId);

  if (origemAdmin) {
    const backLink = document.getElementById("agendamento-back-link");

    if (backLink) {
      backLink.href = "admin-agendamentos.html";
    }
  } else {
    configurarLinkVoltar(serviceInfo?.categoria);
  }

  if (!serviceInfo) {
    botaoAgendar.disabled = true;
    return;
  }

  const serviceName = serviceInfo.nome;

  const serviceDuration = Number(serviceInfo.duracao) || 60;

  const servicePrice = converterPrecoParaNumero(serviceInfo.preco);

  const nomeClienteInput = document.getElementById("nomeCliente");

  let agendamentoOriginal = null;

  if (reagendarId) {
    const agendamentoOriginalRef = doc(db, "agendamentos", reagendarId);

    const agendamentoOriginalSnap = await getDoc(agendamentoOriginalRef);

    if (!agendamentoOriginalSnap.exists()) {
      window.alert(
        "Não foi possível localizar o agendamento que será reagendado.",
      );

      botaoAgendar.disabled = true;

      return;
    }

    agendamentoOriginal = agendamentoOriginalSnap.data();

    const observacoesOriginais = String(
      agendamentoOriginal.observacoes || agendamentoOriginal.observacao || "",
    ).trim();

    if (textareaComentarios && observacoesOriginais) {
      textareaComentarios.value = observacoesOriginais;
    }
  }

  if (origemAdmin && agendamentoOriginal) {
    if (nomeClienteInput) {
      nomeClienteInput.value = String(
        agendamentoOriginal.nomeCliente ||
          agendamentoOriginal.clienteNome ||
          "Cliente",
      ).trim();

      nomeClienteInput.readOnly = true;
    }

    botaoAgendar.textContent = "Confirmar Reagendamento";
  } else {
    preencherNomeClienteDoLocalStorage();

    if (reagendarId) {
      botaoAgendar.textContent = "Confirmar Reagendamento";
    }
  }

  if (nomeClienteInput) {
    nomeClienteInput.addEventListener("input", atualizarResumoAgendamento);
  }

  atualizarResumoAgendamento();

  datas.forEach((botao) => {
    botao.addEventListener("click", () => {
      selecionarUnico(botao, datas, "agendamento-date--active");

      localStorage.setItem("dataAgendamento", formatarData(botao));

      const dataIso = obterDataIso(botao);

      if (dataIso) {
        localStorage.setItem("dataAgendamentoISO", dataIso);
      }

      localStorage.removeItem("horarioAgendamento");

      localStorage.removeItem("horaAgendamento");

      atualizarCabecalhoData(botao);
      atualizarResumoAgendamento();

      renderizarHorarios(dataIso, serviceDuration, reagendarId);
    });
  });

  const horariosContainer = document.querySelector(".agendamento-times");

  if (horariosContainer) {
    horariosContainer.addEventListener("click", (event) => {
      const botao = event.target.closest(".agendamento-time");

      if (
        !botao ||
        botao.disabled ||
        botao.classList.contains("horario-ocupado")
      ) {
        return;
      }

      const todosHorarios = Array.from(
        horariosContainer.querySelectorAll(".agendamento-time"),
      );

      selecionarUnico(botao, todosHorarios, "agendamento-time--active");

      const horarioSelecionado = botao.dataset.time || botao.textContent.trim();

      localStorage.setItem("horarioAgendamento", horarioSelecionado);

      localStorage.setItem("horaAgendamento", horarioSelecionado);

      atualizarResumoAgendamento();
    });
  }

  onAuthStateChanged(auth, (user) => {
    if (!user) return;

    const nomeInput = document.getElementById("nomeCliente");

    if (nomeInput && !origemAdmin) {
      const nomeUsuarioSalvo = localStorage.getItem("nomeUsuario");

      const nomePerfil =
        nomeUsuarioSalvo || user.displayName || user.email || "";

      if (nomePerfil) {
        nomeInput.value = nomePerfil;

        atualizarResumoAgendamento();
      }
    }

    botaoAgendar.addEventListener("click", async () => {
      if (botaoAgendar.disabled) return;
      const horarioSalvo = localStorage.getItem("horarioAgendamento");
      const dataAgendamentoISO = localStorage.getItem("dataAgendamentoISO");
      const horarioNormalizado = String(horarioSalvo || "")
        .toLowerCase()
        .replace(/(am|pm)/g, "")
        .trim();

      const dataSelecionada = document.querySelector(
        ".agendamento-date--active",
      );
      if (dataSelecionada) {
        localStorage.setItem("dataAgendamento", formatarData(dataSelecionada));
      }
      if (horarioSalvo) {
        localStorage.setItem("horaAgendamento", horarioSalvo);
        localStorage.setItem("horarioAgendamento", horarioSalvo);
      }

      if (!validarAgendamento(dataAgendamentoISO, horarioNormalizado)) {
        window.alert("Selecione uma data e horário válidos.");
        return;
      }
      aguardarRedirecionamento(botaoAgendar);

      const nomeInput =
        document.getElementById("nomeCliente") ||
        document.querySelector('input[name="nome"]');
      const nomeCliente = nomeInput ? nomeInput.value : "Nome não informado";
      const servico = serviceName;
      const data = dataAgendamentoISO;
      const horario = horarioNormalizado;
      const observacoes = textareaComentarios?.value?.trim() || "";

      localStorage.setItem("servicoAgendamento", serviceName);
      localStorage.setItem(
        "observacoesAgendamento",
        textareaComentarios?.value?.trim() || "",
      );
      if (!origemAdmin && nomeCliente && nomeCliente.trim()) {
        localStorage.setItem("nomeUsuario", nomeCliente.trim());
      }

      if (!servico || !data || !horario) {
        console.error("[agendamento] ERRO: Dados incompletos para envio!", {
          servico,
          data,
          horario,
        });
        return;
      }

      let idEvento = "evt_" + Math.random().toString(36).substr(2, 9);

      if (reagendarId) {
        const agendamentoAnteriorRef = doc(db, "agendamentos", reagendarId);

        const agendamentoAnteriorSnap = await getDoc(agendamentoAnteriorRef);

        if (!agendamentoAnteriorSnap.exists()) {
          throw new Error(
            "Agendamento original não encontrado para reagendamento.",
          );
        }

        const calendarEventIdOriginal = String(
          agendamentoAnteriorSnap.data().calendarEventId || "",
        ).trim();

        if (!calendarEventIdOriginal) {
          throw new Error("Agendamento original sem calendarEventId.");
        }

        idEvento = calendarEventIdOriginal;
      }

      const payloadWebhook = {
        acao: reagendarId ? "REAGENDAR" : "AGENDAR",
        nomeCliente,
        servico,
        dataInicio: `${data}T${horario}:00`,
        duracaoMinutos: parseInt(serviceDuration, 10) || 60,
        eventId: idEvento,
      };

      const payload = {
        nomeCliente,
        servico,
        data,
        horario,
        observacoes,
        idServico: serviceId || null,
        calendarEventId: idEvento, // Incluímos aqui para simplificar
        duracao: parseInt(serviceDuration, 10),
      };

      if (reagendarId) {
        payload.status = "reagendado";
        payload.reagendadoEm = serverTimestamp();
      }

      try {
        if (reagendarId) {
          await updateDoc(doc(db, "agendamentos", reagendarId), payload);
        } else {
          const agendamentoData = {
            ...payload,

            clienteId: user.uid,

            precoSnapshot: servicePrice,
            duracaoSnapshot: serviceDuration,

            dataCriacao: serverTimestamp(),
            status: "agendado",
          };
          await addDoc(collection(db, "agendamentos"), agendamentoData);
        }

        const googleScriptUrl =
          "https://script.google.com/macros/s/AKfycbwUwXunAdMAroSPAeMHH2ZQxCOuQage7lmAHH7-llgmeVXug6-Z9KGq6R7NVgQ70XYy/exec";

        try {
          await fetch(googleScriptUrl, {
            method: "POST",
            mode: "no-cors",
            body: JSON.stringify(payloadWebhook),
          });
        } catch (fetchError) {
          console.error(
            "Erro de rede ao sincronizar o agendamento com o Google Apps Script:",
            fetchError,
          );

          window.alert(
            "Seu agendamento foi salvo, mas houve uma falha na sincronização com a agenda. A reserva continuará registrada.",
          );
        }

        localStorage.setItem("dataAgendamento", data);
        localStorage.setItem("horaAgendamento", horario);
        // Sugestão: salve o nome do cliente também para usar na tela de confirmação
        localStorage.setItem("nomeCliente", payloadWebhook.nomeCliente);

        window.location.href = origemAdmin
          ? "admin-agendamentos.html"
          : "confirmacao.html";
      } catch (error) {
        console.error(error);
        window.alert("Erro ao salvar agendamento.");
        botaoAgendar.disabled = false;
        botaoAgendar.textContent = "Confirmar Agendamento";
      }
    });
  });

  const diaAtivo =
    obterSelecionado(datas, "agendamento-date--active") || datas[0];

  if (diaAtivo) {
    const dataIso = obterDataIso(diaAtivo);

    atualizarCabecalhoData(diaAtivo);

    if (dataIso) {
      localStorage.setItem("dataAgendamentoISO", dataIso);

      await renderizarHorarios(dataIso, serviceDuration, reagendarId);
    }
  }

  atualizarResumoAgendamento();
}

document.addEventListener("DOMContentLoaded", inicializarAgendamento);
