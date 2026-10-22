import { auth, db } from "./firebase-config.js";
import { calcularJanelaMensal, estaNaJanelaMensal, formatarDataBrasil } from "./agendaJanela.js";
import { consultarDisponibilidadePix, reagendarAgendamentoApi } from "./agendamentosApi.js";
import { consultarIntervalosDisponibilidade, intervaloSobrepoeDisponibilidade, obterIniciosEspeciaisSemanais, obterLimitesAtendimentoSemanal, validarHorarioEspecialSemanal } from "./agendamentoDisponibilidade.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
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

function aguardarUsuarioFirebase() {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    let parar = () => {};
    parar = onAuthStateChanged(auth, (usuario) => {
      parar();
      resolve(usuario);
    });
  });
}

function validarAgendamento(data, hora) {
  if (!data || !hora) return false;

  const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(data);
  const horaOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);

  if (!dataOk || !horaOk) return false;

  if (!estaNaJanelaMensal(data)) return false;

  // Bloqueia agendamentos anteriores a novembro de 2026.
  if (data < "2026-11-01") {
    return false;
  }

  // Dezembro de 2026 permanece bloqueado.
  if (data.startsWith("2026-12-") && !DATAS_DEZEMBRO_LIBERADAS.has(data)) {
    return false;
  }

  return true;
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

const DATAS_DEZEMBRO_LIBERADAS = new Set([]);

let mesCalendarioAtual = null;

function primeiroDiaDoMes(dataIso) {
  const [ano, mes] = dataIso.split("-").map(Number);
  return new Date(ano, mes - 1, 1, 12, 0, 0);
}

function gerarCalendarioDias(container, dataMes = null) {
  if (!container) return;

  const hojeIso = formatarDataBrasil();
  const { fim: limiteIso } = calcularJanelaMensal();
  const minimoIso = hojeIso < "2026-11-01" ? "2026-11-01" : hojeIso;
  const mesHoje = primeiroDiaDoMes(hojeIso);
  const mesLimite = primeiroDiaDoMes(limiteIso);
  mesCalendarioAtual = dataMes || mesCalendarioAtual || mesHoje;
  mesCalendarioAtual = primeiroDiaDoMes(formatarDataIsoLocal(mesCalendarioAtual));
  if (mesCalendarioAtual < mesHoje) mesCalendarioAtual = mesHoje;
  if (mesCalendarioAtual > mesLimite) mesCalendarioAtual = mesLimite;
  container.replaceChildren();

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

  const titulo = document.getElementById("calendar-month-label");
  if (titulo) titulo.textContent = formatarMesAno(mesCalendarioAtual);
  const anterior = document.getElementById("calendar-previous-month");
  const proximo = document.getElementById("calendar-next-month");
  if (anterior) anterior.disabled = mesCalendarioAtual <= mesHoje;
  if (proximo) {
    const proximoMes = new Date(mesCalendarioAtual.getFullYear(), mesCalendarioAtual.getMonth() + 1, 1, 12);
    proximo.disabled = proximoMes > mesLimite;
  }

  container.classList.add("agendamento-calendar--month");
  weekNames.forEach((name) => {
    const weekday = document.createElement("span");
    weekday.className = "agendamento-calendar-weekday";
    weekday.textContent = name;
    weekday.setAttribute("aria-hidden", "true");
    container.appendChild(weekday);
  });

  const firstOffset = mesCalendarioAtual.getDay();
  for (let i = 0; i < firstOffset; i += 1) {
    const spacer = document.createElement("span");
    spacer.className = "agendamento-calendar-spacer";
    spacer.setAttribute("aria-hidden", "true");
    container.appendChild(spacer);
  }

  const diasNoMes = new Date(mesCalendarioAtual.getFullYear(), mesCalendarioAtual.getMonth() + 1, 0).getDate();
  const datasElegiveis = [];
  for (let dia = 1; dia <= diasNoMes; dia += 1) {
    const dataAtual = new Date(mesCalendarioAtual.getFullYear(), mesCalendarioAtual.getMonth(), dia, 12);
    const dataIso = formatarDataIsoLocal(dataAtual);
    const dezembroBloqueado = dataIso.startsWith("2026-12-") && !DATAS_DEZEMBRO_LIBERADAS.has(dataIso);
    const disponivel = dataIso >= minimoIso && estaNaJanelaMensal(dataIso) && diasAtendimento.has(dataAtual.getDay()) && !dezembroBloqueado;
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "agendamento-date";
    botao.dataset.dateIso = dataIso;
    botao.dataset.dateLabel = formatarDataLonga(dataAtual);
    botao.dataset.monthLabel = formatarMesAno(dataAtual);
    botao.disabled = !disponivel;
    botao.setAttribute("aria-pressed", "false");
    botao.setAttribute("aria-label", `${formatarDataLonga(dataAtual)}${disponivel ? ", disponível" : ", indisponível"}`);
    botao.innerHTML = `<span class="agendamento-date-label">${weekNames[dataAtual.getDay()]}</span><span class="agendamento-date-day">${String(dia).padStart(2, "0")}</span><span class="agendamento-date-month">${monthNames[dataAtual.getMonth()]}</span>`;
    if (dataIso === hojeIso) botao.classList.add("agendamento-date--today");
    container.appendChild(botao);
    if (disponivel) datasElegiveis.push(botao);
  }

  const salvo = localStorage.getItem("dataAgendamentoISO");
  const selecionado = datasElegiveis.find((botao) => botao.dataset.dateIso === salvo) || datasElegiveis[0];
  if (selecionado) {
    selecionado.classList.add("agendamento-date--active");
    selecionado.setAttribute("aria-pressed", "true");
    localStorage.setItem("dataAgendamento", formatarData(selecionado));
    localStorage.setItem("dataAgendamentoISO", obterDataIso(selecionado));
    atualizarCabecalhoData(selecionado);
  } else {
    localStorage.removeItem("dataAgendamento");
    localStorage.removeItem("dataAgendamentoISO");
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

  const intervalos = [
    {
      start: timeToMins("13:30"),
      end: timeToMins("14:00"),
    },
  ];

  if (diaSemana === 2) {
    intervalos.push({
      start: timeToMins("09:00"),
      end: timeToMins("13:30"),
    });
  }

  return intervalos;
}
async function renderizarHorarios(dataIso, servicoDuracao, reagendarId = null) {
  const requisicao = (renderizarHorarios.requisicao || 0) + 1;
  renderizarHorarios.requisicao = requisicao;
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
    const statusValidos = ["agendado", "reagendado", "confirmado"];
    const usuario = await aguardarUsuarioFirebase();
    if (!usuario) throw new Error("Entre na sua conta para consultar os horários.");
    const intervalosOcupados = await consultarIntervalosDisponibilidade({
      async consultarAgendamentosFirestore() {
        const consulta = query(
          collection(db, "agendamentos"),
          where("data", "==", String(dataIso).trim()),
        );
        const querySnapshot = await getDocs(consulta);
        const intervalos = [];
        querySnapshot.forEach((documento) => {
          const dados = documento.data();
          if ((reagendarId && documento.id === reagendarId) ||
              !dados.horario || !statusValidos.includes(dados.status)) return;
          const inicio = timeToMins(dados.horario);
          const duracaoAgendada = Number(dados.duracao) || 90;
          intervalos.push({ inicioMinuto: inicio, fimMinuto: inicio + duracaoAgendada });
        });
        return intervalos;
      },
      consultarReservasPix() {
        return consultarDisponibilidadePix(auth, String(dataIso).trim(), reagendarId);
      },
    });
    if (requisicao !== renderizarHorarios.requisicao) return;

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

    const intervalosBloqueadosFixos = obterIntervalosBloqueadosFixos(dataIso).map((intervalo) => ({
      inicioMinuto: intervalo.start,
      fimMinuto: intervalo.end,
    }));

    const intervalosIndisponiveis = [
      ...intervalosOcupados,
      ...intervalosBloqueadosFixos,
    ];

    const { minAbertura, minUltimoInicio, minFechamento } =
      obterLimitesAtendimentoSemanal(diaSemanaSelecionado);

    const horariosManha = [];
    const horariosTarde = [];

    let quantidadeDisponivel = 0;

    const iniciosEspeciais = obterIniciosEspeciaisSemanais(diaSemanaSelecionado);
    const horariosCandidatos = iniciosEspeciais || Array.from(
      { length: Math.floor((minUltimoInicio - minAbertura) / 30) + 1 },
      (_, indice) => minAbertura + indice * 30,
    );

    for (const atual of horariosCandidatos) {
      const fimServico = atual + duracaoServico;

      if (fimServico > minFechamento && diaSemanaSelecionado !== 3) {
        continue;
      }

      const horarioTexto = minsToTime(atual);

      const horarioEspecialInvalido =
        !validarHorarioEspecialSemanal(diaSemanaSelecionado, atual, duracaoServico);

      const indisponivel =
        horarioEspecialInvalido ||
        intervaloSobrepoeDisponibilidade(atual, fimServico, intervalosIndisponiveis);

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

    criarGrupoHorario("Manhã", diaSemanaSelecionado === 4 ? "Das 11h às 12h" : diaSemanaSelecionado === 3 ? "Início às 09:00" : "Das 9h às 12h", horariosManha);

    criarGrupoHorario("Tarde", diaSemanaSelecionado === 3 ? "Início às 14:00" : [4, 5, 6].includes(diaSemanaSelecionado)
      ? "Inícios até 19h" : "Das 12h às 18h", horariosTarde);

    if (availabilityElement) {
      availabilityElement.textContent =
        quantidadeDisponivel === 1
          ? "1 horário"
          : `${quantidadeDisponivel} horários`;
    }

    if (quantidadeDisponivel === 0 && diaSemanaSelecionado === 3) {
      const aviso = document.createElement("div");
      aviso.className = "agendamento-time-state";
      aviso.textContent = "Não há horários disponíveis nesta data.";
      container.appendChild(aviso);
    } else if (quantidadeDisponivel === 0) {
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
    if (requisicao !== renderizarHorarios.requisicao) return;
    console.error("Erro ao carregar horários:", error);
    localStorage.removeItem("horarioAgendamento");
    localStorage.removeItem("horaAgendamento");

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
  const botaoAgendar = document.querySelector(".agendamento-button");

  const textareaComentarios = document.querySelector("#agendamento-notes");
  const urlParams = new URLSearchParams(window.location.search);
  if (!botaoAgendar) {
    console.error("Botão agendar não encontrado no DOM!");
  }
  const serviceId = urlParams.get("id");
  const reagendarId = urlParams.get("reagendar");
  const origemAdmin = urlParams.get("origem") === "admin";

  if (!botaoAgendar || !calendarContainer || !textareaComentarios) return;

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

    if (
      agendamentoOriginal.pixCobrancaId ||
      agendamentoOriginal.pixPagamentoId
    ) {
      window.alert(
        "Este atendimento tem sinal PIX. O reagendamento precisa de conciliação financeira pelo salão para evitar cobranças duplicadas. Entre em contato com a Isabele.",
      );
      botaoAgendar.disabled = true;
      return;
    }

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

  const obterDatasElegiveis = () => Array.from(
    calendarContainer.querySelectorAll(".agendamento-date:not(:disabled)"),
  );

  async function aplicarDataSelecionada(botao) {
    const datasAtuais = obterDatasElegiveis();
    selecionarUnico(botao, datasAtuais, "agendamento-date--active");

    localStorage.setItem("dataAgendamento", formatarData(botao));

    const dataIso = obterDataIso(botao);

    if (dataIso) localStorage.setItem("dataAgendamentoISO", dataIso);

    localStorage.removeItem("horarioAgendamento");
    localStorage.removeItem("horaAgendamento");
    atualizarCabecalhoData(botao);
    atualizarResumoAgendamento();
    await renderizarHorarios(dataIso, serviceDuration, reagendarId);
  }

  calendarContainer.addEventListener("click", (event) => {
    const botao = event.target.closest(".agendamento-date");
    if (!botao || botao.disabled) return;
    void aplicarDataSelecionada(botao);
  });

  const selecionarMes = (quantidade) => {
    const novoMes = new Date(
      mesCalendarioAtual.getFullYear(),
      mesCalendarioAtual.getMonth() + quantidade,
      1,
      12,
    );
    gerarCalendarioDias(calendarContainer, novoMes);
    const dataAtiva = calendarContainer.querySelector(".agendamento-date--active");
    localStorage.removeItem("horarioAgendamento");
    localStorage.removeItem("horaAgendamento");
    if (dataAtiva) {
      const iso = obterDataIso(dataAtiva);
      if (iso) void renderizarHorarios(iso, serviceDuration, reagendarId);
    } else {
      localStorage.removeItem("dataAgendamentoISO");
      localStorage.removeItem("dataAgendamento");
      const container = document.querySelector(".agendamento-times");
      if (container) container.innerHTML = '<div class="agendamento-time-state">Não há datas de atendimento disponíveis neste mês.</div>';
      const status = document.getElementById("availability-status");
      if (status) status.textContent = "Sem datas";
      atualizarResumoAgendamento();
    }
  };

  document.getElementById("calendar-previous-month")?.addEventListener("click", () => selecionarMes(-1));
  document.getElementById("calendar-next-month")?.addEventListener("click", () => selecionarMes(1));

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

        if (
          agendamentoAnteriorSnap.data().pixCobrancaId ||
          agendamentoAnteriorSnap.data().pixPagamentoId
        ) {
          throw new Error(
            "Atendimento com PIX exige conciliacao financeira antes do reagendamento.",
          );
        }

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

      try {
        if (reagendarId) {
          const resultadoReagendamento = await reagendarAgendamentoApi(auth, {
            agendamentoId: reagendarId,
            servicoId: serviceId,
            data,
            horario,
            observacoes,
          });
          idEvento = resultadoReagendamento.calendarEventId || idEvento;
          payloadWebhook.eventId = idEvento;
        } else {
          throw new Error("Confirme o novo agendamento pelo fluxo seguro da agenda.");
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

  const datas = obterDatasElegiveis();
  const diaAtivo = obterSelecionado(datas, "agendamento-date--active") || datas[0];

  if (diaAtivo) {
    const dataIso = obterDataIso(diaAtivo);

    atualizarCabecalhoData(diaAtivo);

    if (dataIso) {
      localStorage.setItem("dataAgendamentoISO", dataIso);

      await renderizarHorarios(dataIso, serviceDuration, reagendarId);
    }
  }

  let ultimaAtualizacaoVisibilidade = 0;
  const atualizarAoRetornar = () => {
    if (document.visibilityState !== "visible") return;
    const agora = Date.now();
    if (agora - ultimaAtualizacaoVisibilidade < 1000) return;
    ultimaAtualizacaoVisibilidade = agora;
    const diasAtuais = obterDatasElegiveis();
    const dataAtiva = obterDataIso(obterSelecionado(diasAtuais, "agendamento-date--active") || diasAtuais[0]);
    if (dataAtiva) void renderizarHorarios(dataAtiva, serviceDuration, reagendarId);
  };
  window.addEventListener("pageshow", atualizarAoRetornar);
  document.addEventListener("visibilitychange", atualizarAoRetornar);

  atualizarResumoAgendamento();
}

document.addEventListener("DOMContentLoaded", inicializarAgendamento);


