import { auth, db } from "./firebase-config.js";
import { obterMesPredominante } from "./agendamentoMes.mjs?v=1.0.0";
import { consultarDisponibilidadePix, reagendarAgendamentoApi, consultarReagendamentoPixConfigApi, consultarReagendamentoPixPagoApi } from "./agendamentosApi.js";
import { consultarIntervalosDisponibilidade, intervaloSobrepoeDisponibilidade, } from "./agendamentoDisponibilidade.js?v=2.2.0";
import { obterJanelaAgendamento, validarDataNaJanela, validarHorarioEspecial, obterExpedienteEspecialDezembro2026, validarServicoDezembro2026, obterJanelasAtendimento, AGENDA_DEZEMBRO_2026_ABERTA } from "./infra/backend/src/agendamentoRegras.mjs?v=2.3.0";
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

  return validarDataNaJanela(data).valido;
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
    monthElement.value = botaoData.dataset.monthKey || "";
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
  // A sugestão só fica marcada quando a seleção real de data e horário é válida.
  document.querySelectorAll("[data-agenda-sugestao]").forEach((botao) => {
    const ativa = botao.dataset.dateIso === dataSelecionada?.dataset.dateIso &&
      botao.dataset.time === horarioSelecionado?.dataset.time;
    botao.classList.toggle("agenda-sugestoes-hora--ativa", ativa);
    botao.setAttribute("aria-pressed", String(ativa));
  });
}

function obterHojeSaoPauloParaTela() {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${valores.year}-${valores.month}-${valores.day}`;
}

function minutoAtualSaoPaulo() {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map((item) => [item.type, item.value]));
  return Number(valores.hour) * 60 + Number(valores.minute);
}

/**
 * Sugestões não atrasam a agenda: apenas uma consulta Firestore para sete dias.
 * Se ela falhar, o calendário original permanece utilizável.
 */
async function carregarSugestoesHorarios({ datas, serviceDuration, serviceInfo, selecionarDataAgendamento }) {
  const secao = document.getElementById("agenda-sugestoes");
  const lista = secao?.querySelector("[data-agenda-sugestoes-lista]");
  if (!secao || !lista) return;
  try {
    const { escolherDiasSemana, sugerirHorarios } = await import("./agendaSugestoes.mjs?v=1.0.0");
    const hoje = obterHojeSaoPauloParaTela();
    const diasSemana = escolherDiasSemana(datas.map((botao) => botao.dataset.dateIso), hoje);
    if (!diasSemana.length) return;
    const usuario = await aguardarUsuarioFirebase();
    if (!usuario || auth.currentUser?.uid !== usuario.uid) return;
    // Nada de sete chamadas PIX: a API continua obrigatória na escolha real.
    const consulta = query(collection(db, "agendamentos"),
      where("data", ">=", diasSemana[0]),
      where("data", "<=", diasSemana[diasSemana.length - 1]));
    const documentos = await getDocs(consulta);
    if (auth.currentUser?.uid !== usuario.uid) return;
    const sugestoes = sugerirHorarios({
      datas: diasSemana, hoje, minutoAtual: minutoAtualSaoPaulo(),
      agendamentos: documentos.docs.map((doc) => doc.data()),
      duracao: serviceDuration, servico: serviceInfo, clienteId: usuario.uid,
    });
    if (!sugestoes.length) return;
    const frag = document.createDocumentFragment();
    for (const sugestao of sugestoes) {
      const botaoData = datas.find((botao) => botao.dataset.dateIso === sugestao.dataIso);
      if (!botaoData) continue;
      const dia = document.createElement("article");
      dia.className = "agenda-sugestoes-dia";
      const rotulo = document.createElement("strong");
      rotulo.className = "agenda-sugestoes-data";
      const semana = botaoData.querySelector(".agendamento-date-label")?.textContent.trim() || "";
      const numero = botaoData.querySelector(".agendamento-date-day")?.textContent.trim() || "";
      const mes = botaoData.querySelector(".agendamento-date-month")?.textContent.trim() || "";
      rotulo.textContent = `${semana}, ${numero} ${mes}`;
      const horas = document.createElement("div");
      horas.className = "agenda-sugestoes-horarios";
      for (const horario of sugestao.horarios) {
        const botao = document.createElement("button");
        botao.type = "button";
        botao.className = "agenda-sugestoes-hora";
        botao.textContent = horario;
        botao.dataset.agendaSugestao = "";
        botao.dataset.dateIso = sugestao.dataIso;
        botao.dataset.time = horario;
        botao.setAttribute("aria-pressed", "false");
        botao.setAttribute("aria-label", `${botaoData.dataset.dateLabel}, às ${horario}`);
        horas.appendChild(botao);
      }
      dia.append(rotulo, horas);
      frag.appendChild(dia);
    }
    if (!frag.childNodes.length) return;
    lista.replaceChildren(frag);
    lista.addEventListener("click", async (event) => {
      const botao = event.target.closest("button[data-agenda-sugestao]");
      if (!botao || botao.disabled) return;
      const botaoData = datas.find((dia) => dia.dataset.dateIso === botao.dataset.dateIso);
      if (!botaoData) return;
      botao.disabled = true;
      try {
        await selecionarDataAgendamento(botaoData, botao.dataset.time);
      } finally {
        botao.disabled = false;
      }
    });
    secao.hidden = false;
    atualizarResumoAgendamento();
  } catch (error) {
    console.warn("[Agenda Sugestões] Indisponível; calendário preservado:", error.message);
    secao.hidden = true;
  }
}

function configurarNavegacaoMes(container, dias) {
  const seletor = document.getElementById("calendar-month-label");
  if (!container || !seletor || !dias.length) return;

  const meses = new Map();
  dias.forEach((dia) => {
    const chave = dia.dataset.monthKey;
    if (chave && !meses.has(chave)) meses.set(chave, dia.dataset.monthLabel);
  });

  seletor.replaceChildren();
  for (const [chave, rotulo] of meses) {
    const opcao = document.createElement("option");
    opcao.value = chave;
    opcao.textContent = rotulo;
    seletor.appendChild(opcao);
  }

  const atualizarMesVisivel = () => {
    const viewport = container.getBoundingClientRect();
    const cartoes = dias.map((dia) => {
      const retangulo = dia.getBoundingClientRect();
      return {
        mes: dia.dataset.monthKey,
        inicio: retangulo.left,
        fim: retangulo.right,
      };
    });
    const mes = obterMesPredominante(cartoes, viewport.left, viewport.right);
    if (mes && seletor.value !== mes) seletor.value = mes;
  };

  let scrollPendente = false;
  container.addEventListener("scroll", () => {
    if (scrollPendente) return;
    scrollPendente = true;
    requestAnimationFrame(() => {
      scrollPendente = false;
      atualizarMesVisivel();
    });
  }, { passive: true });

  seletor.addEventListener("change", () => {
    const primeiraDataDoMes = dias.find((dia) => dia.dataset.monthKey === seletor.value);
    if (!primeiraDataDoMes) return;
    const viewport = container.getBoundingClientRect();
    const destino = primeiraDataDoMes.getBoundingClientRect();
    container.scrollTo({
      left: Math.max(0, container.scrollLeft + destino.left - viewport.left),
      behavior: "auto",
    });
    requestAnimationFrame(atualizarMesVisivel);
    // Navegar entre meses não modifica o dia/horário escolhido.
  });

  atualizarMesVisivel();
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

  const janela = obterJanelaAgendamento();
  const [inicioAno, inicioMes, inicioDia] = janela.inicio.split("-").map(Number);
  const [fimAno, fimMes, fimDia] = janela.fim.split("-").map(Number);
  const hojeIso = obterHojeSaoPauloParaTela();
  const cursor = new Date(inicioAno, inicioMes - 1, inicioDia, 12, 0, 0);
  const limite = new Date(fimAno, fimMes - 1, fimDia, 12, 0, 0);

  while (cursor <= limite) {
    const dataAtual = new Date(cursor);
    const dataIso = formatarDataIsoLocal(dataAtual);
    const especial = obterExpedienteEspecialDezembro2026(dataIso);
    // December stays hidden until an explicit future release.
    const dezembroBloqueado = dataIso.startsWith("2026-12") && !AGENDA_DEZEMBRO_2026_ABERTA;

    if (!dezembroBloqueado && (especial ? especial.aberto : diasAtendimento.has(cursor.getDay()))) {

      const botao = document.createElement("button");

      botao.type = "button";
      botao.className = "agendamento-date";

      botao.dataset.dateIso = dataIso;
      botao.dataset.dateLabel = formatarDataLonga(dataAtual);

      botao.dataset.monthLabel = formatarMesAno(dataAtual);
      botao.dataset.monthKey = dataIso.slice(0, 7);

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

  configurarNavegacaoMes(container, dias);

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
async function renderizarHorarios(dataIso, servicoDuracao, reagendarId = null, servicoInfo = null) {
  const requisicao = (renderizarHorarios.requisicao || 0) + 1;
  renderizarHorarios.requisicao = requisicao;
  const container = document.querySelector(".agendamento-times");

  const availabilityElement = document.getElementById("availability-status");
  const alternarIndisponiveis = document.getElementById("agendamento-ver-indisponiveis");
  if (alternarIndisponiveis) {
    alternarIndisponiveis.hidden = true;
    alternarIndisponiveis.setAttribute("aria-pressed", "false");
    alternarIndisponiveis.onclick = null;
  }

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
    const regraServico = validarServicoDezembro2026(dataIso, servicoInfo);
    if (!regraServico.valido) {
      container.textContent = regraServico.motivo;
      if (availabilityElement) availabilityElement.textContent = "Serviço indisponível";
      return;
    }
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
          intervalos.push({
            inicioMinuto: inicio, fimMinuto: inicio + duracaoAgendada, tipo: "agendamento",
            ...(!reagendarId && statusValidos.includes(dados.status) &&
                dados.clienteId === usuario.uid ? { sequencialMesmaCliente: true } : {}),
          });
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

    // Os períodos do dia vêm da mesma regra compartilhada com o backend.
    // Não existem mais fechamentos artificiais ou exceções para :15/:45.
    const intervalosIndisponiveis = intervalosOcupados;
    const especial = obterExpedienteEspecialDezembro2026(dataIso);
    const janelas = obterJanelasAtendimento(dataIso);
    if (!janelas.length) {
      container.textContent = "Não há expediente nesta data.";
      if (availabilityElement) availabilityElement.textContent = "Sem expediente";
      return;
    }
    const minFechamento = Math.max(...janelas.map((janela) => janela.encerramentoMinuto));

    const horariosManha = [];
    const horariosTarde = [];
    const horariosNoite = [];

    let quantidadeDisponivel = 0;
    let quantidadeIndisponivel = 0;
    const controlesPeriodos = [];

    // A grade inteira usa 15 minutos; cada início é checado pela duração real,
    // janela de expediente e bloqueios. Nenhum início é aberto à força.
    const iniciosPossiveis = [...new Set(janelas.flatMap(({ inicioMinuto, encerramentoMinuto }) => {
      const inicios = [];
      for (let minuto = inicioMinuto; minuto <= encerramentoMinuto - 15; minuto += 15) {
        inicios.push(minuto);
      }
      return inicios;
    }))].sort((a, b) => a - b);

    for (const atual of iniciosPossiveis) {
      const fimServico = atual + duracaoServico;
      const horarioTexto = minsToTime(atual);

      const bloqueadoPorRegraEspecial =
        !validarHorarioEspecial(dataIso, horarioTexto, duracaoServico);

      const indisponivel =
        bloqueadoPorRegraEspecial ||
        intervaloSobrepoeDisponibilidade(atual, fimServico, intervalosIndisponiveis);

      const botao = document.createElement("button");

      botao.type = "button";
      botao.className = "agendamento-time";
      botao.textContent = horarioTexto;
      botao.dataset.time = horarioTexto;

      botao.setAttribute("aria-pressed", "false");

      if (indisponivel) {
        quantidadeIndisponivel += 1;
        // Mantém o slot na grade para a visualização opcional; padrão = livres.
        botao.hidden = true;
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
      } else if (atual < timeToMins("18:00")) {
        horariosTarde.push(botao);
      } else {
        horariosNoite.push(botao);
      }
    }

    container.innerHTML = "";

    function criarGrupoHorario(titulo, subtitulo, horarios) {
      if (!horarios.length) return;

      const periodo = document.createElement("section");
      periodo.className = "agendamento-period";
      periodo.setAttribute("aria-label", "Horários de " + titulo.toLowerCase());

      const heading = document.createElement("div");
      heading.className = "agendamento-period-heading";
      const title = document.createElement("strong");
      title.textContent = titulo;
      const description = document.createElement("span");
      const livresNoPeriodo = horarios.filter((botao) => !botao.disabled).length;
      description.textContent = subtitulo + " · " + livresNoPeriodo +
        (livresNoPeriodo === 1 ? " livre" : " livres");
      heading.append(title, description);

      const carousel = document.createElement("div");
      carousel.className = "agendamento-carousel";
      const rolagem = document.createElement("div");
      rolagem.className = "agendamento-time-carousel";
      rolagem.setAttribute("role", "group");
      rolagem.setAttribute("aria-label", "Deslize para escolher um horário de " + titulo.toLowerCase());
      rolagem.tabIndex = 0;
      horarios.forEach((horario) => rolagem.appendChild(horario));

      const criarSeta = (simbolo, direcao, nome) => {
        const seta = document.createElement("button");
        seta.type = "button";
        seta.className = "agendamento-carousel-arrow";
        seta.textContent = simbolo;
        seta.setAttribute("aria-label", nome + " horários de " + titulo.toLowerCase());
        seta.addEventListener("click", () => {
          rolagem.scrollBy({ left: direcao * Math.max(rolagem.clientWidth * 0.75, 230), behavior: "smooth" });
        });
        return seta;
      };
      const anterior = criarSeta("‹", -1, "Ver anteriores");
      const proximo = criarSeta("›", 1, "Ver próximos");
      const atualizarSetas = () => {
        anterior.disabled = rolagem.scrollLeft <= 2;
        proximo.disabled = rolagem.scrollLeft >= rolagem.scrollWidth - rolagem.clientWidth - 2;
      };
      rolagem.addEventListener("scroll", atualizarSetas, { passive: true });
      carousel.append(anterior, rolagem, proximo);
      const dica = document.createElement("p");
      dica.className = "agendamento-carousel-hint";
      dica.textContent = "Deslize para ver mais horários";
      const vazio = document.createElement("p");
      vazio.className = "agendamento-period-empty";
      vazio.textContent = "Sem horários disponíveis neste período.";
      vazio.hidden = livresNoPeriodo > 0;
      carousel.hidden = livresNoPeriodo === 0;
      dica.hidden = livresNoPeriodo === 0;
      periodo.append(heading, carousel, dica, vazio);
      container.appendChild(periodo);
      controlesPeriodos.push({ rolagem, carousel, dica, vazio, atualizarSetas });
      if (livresNoPeriodo) requestAnimationFrame(atualizarSetas);
    }

    criarGrupoHorario("Manhã", "Antes das 12h", horariosManha);
    criarGrupoHorario("Tarde", "Das 12h às 18h", horariosTarde);
    criarGrupoHorario("Noite", "A partir das 18h · término até " + minsToTime(minFechamento), horariosNoite);

    if (availabilityElement) {
      availabilityElement.textContent = quantidadeDisponivel === 1
        ? "1 horário livre" : `${quantidadeDisponivel} horários livres`;
    }

    if (quantidadeDisponivel === 0) {
      const aviso = document.createElement("div");
      aviso.className = "agendamento-time-state";
      aviso.textContent = "Não há horários disponíveis nesta data para este serviço. " +
        "Escolha outro dia ou veja os horários indisponíveis.";
      container.appendChild(aviso);
    }

    if (alternarIndisponiveis && quantidadeIndisponivel > 0) {
      alternarIndisponiveis.hidden = false;
      const rotuloPadrao = "Ver horários indisponíveis (" + quantidadeIndisponivel + ")";
      alternarIndisponiveis.textContent = rotuloPadrao;
      alternarIndisponiveis.onclick = () => {
        const mostrar = alternarIndisponiveis.getAttribute("aria-pressed") !== "true";
        alternarIndisponiveis.setAttribute("aria-pressed", String(mostrar));
        alternarIndisponiveis.textContent = mostrar
          ? "Ocultar horários indisponíveis" : rotuloPadrao;
        for (const controle of controlesPeriodos) {
          for (const slot of controle.rolagem.querySelectorAll(".agendamento-time:disabled")) {
            slot.hidden = !mostrar;
          }
          const possuiVisiveis = [...controle.rolagem.children].some((botao) => !botao.hidden);
          controle.carousel.hidden = !possuiVisiveis;
          controle.dica.hidden = !possuiVisiveis;
          controle.vazio.hidden = possuiVisiveis;
          controle.rolagem.scrollLeft = 0;
          if (possuiVisiveis) requestAnimationFrame(controle.atualizarSetas);
        }
      };
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

    if (agendamentoOriginal.pixCobrancaId || agendamentoOriginal.pixPagamentoId) {
      // Não abrir horários até o backend confirmar que o worker conciliado
      // e a migração PIX foram publicados. Nunca iniciar outro PIX.
      await aguardarUsuarioFirebase();
      if (!(await consultarReagendamentoPixConfigApi(auth))) {
        window.alert("O reagendamento de sinal PIX pago ainda está indisponível. Entre em contato com a Isabele.");
        botaoAgendar.disabled = true;
        return;
      }
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

  async function selecionarDataAgendamento(botao, horarioSugerido = null) {
    selecionarUnico(botao, datas, "agendamento-date--active");
    localStorage.setItem("dataAgendamento", formatarData(botao));
    const dataIso = obterDataIso(botao);
    if (dataIso) localStorage.setItem("dataAgendamentoISO", dataIso);
    localStorage.removeItem("horarioAgendamento");
    localStorage.removeItem("horaAgendamento");
    atualizarCabecalhoData(botao);
    atualizarResumoAgendamento();
    await renderizarHorarios(dataIso, serviceDuration, reagendarId, serviceInfo);
    if (!horarioSugerido ||
        obterDataIso(obterSelecionado(datas, "agendamento-date--active")) !== dataIso) return;
    // Revalida PIX, bloqueios e regras atuais; nunca seleciona um horário inválido.
    const opcao = [...document.querySelectorAll(".agendamento-times .agendamento-time")]
      .find((item) => item.dataset.time === horarioSugerido && !item.disabled);
    if (opcao) opcao.click();
  }
  datas.forEach((botao) => {
    botao.addEventListener("click", () => { void selecionarDataAgendamento(botao); });
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
      let origemPixPaga = false;

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

        origemPixPaga = Boolean(
          agendamentoAnteriorSnap.data().pixCobrancaId ||
          agendamentoAnteriorSnap.data().pixPagamentoId
        );
        // O backend revalida pagamento pago, serviço, destino e vínculo do
        // evento; esta variável apenas controla o comportamento da interface.

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
          const operacaoKey = `pix-reagendamento:${reagendarId}:${data}:${horario}`;
          // Mesmo identificador em retentativas com ou sem PIX.
          // O backend consegue reconciliar uma sincronizacao Google
          // incerta sem criar outra operacao de calendario.
          let operationId = sessionStorage.getItem(operacaoKey);
          if (!operationId) {
            operationId = crypto.randomUUID();
            sessionStorage.setItem(operacaoKey, operationId);
          }
          const resultadoReagendamento = await reagendarAgendamentoApi(auth, {
            agendamentoId: reagendarId,
            servicoId: serviceId,
            data,
            horario,
            observacoes,
            // Handshake: versões antigas do PWA não enviam este campo.
            // No cutover, o backend pode bloquear clientes desatualizados
            // ANTES de escrever no Firestore ou movimentar horários.
            calendarClientSupportsBackend: true,
            ...(operationId ? { operationId } : {}),
          });
          idEvento = resultadoReagendamento.calendarEventId || idEvento;
          payloadWebhook.eventId = idEvento;

          if (origemPixPaga && resultadoReagendamento.operationId) {
            // O worker é o ÚNICO responsável por atualizar o Calendar PIX.
            // O frontend não dispara REAGENDAR em no-cors neste caminho.
            let estado = resultadoReagendamento;
            for (let tentativa = 0; tentativa < 20 && estado.estado !== "concluida"; tentativa++) {
              botaoAgendar.textContent = "Sincronizando com a agenda...";
              await new Promise((resolve) => setTimeout(resolve, 1500));
              estado = await consultarReagendamentoPixPagoApi(auth, operationId);
            }
            if (estado.estado !== "concluida") {
              window.alert("Seu pedido de reagendamento está registrado e em sincronização. O sinal PIX permanece pago. Confira o agendamento antes de tentar novamente.");
              botaoAgendar.textContent = "Reagendamento em processamento";
              botaoAgendar.disabled = true;
              return;
            }
            sessionStorage.removeItem(operacaoKey);
          }
          if (origemPixPaga) {
            // O backend só conclui após Calendar, Firestore e PostgreSQL.
            localStorage.setItem("dataAgendamento", data);
            localStorage.setItem("horaAgendamento", horario);
            localStorage.setItem("nomeCliente", payloadWebhook.nomeCliente);
            window.location.href = origemAdmin
              ? "admin-agendamentos.html"
              : "confirmacao.html";
            return;
          }
          if (resultadoReagendamento.calendarDiretoHabilitado === true) {
            // A API ja assumiu a sincronizacao; duplicar pelo antigo
            // Apps Script criaria operacoes concorrentes no mesmo evento.
            if (resultadoReagendamento.sincronizacaoCalendar === "pendente") {
              window.alert("Seu reagendamento foi salvo, mas o Google Calendar ainda não confirmou. Você pode verificar novamente usando este botão, sem criar outra reserva.");
              botaoAgendar.textContent = "Verificar sincronização";
              botaoAgendar.disabled = false;
              botaoAgendar.classList.remove("agendamento-button--disabled");
              return;
            }
            if (resultadoReagendamento.sincronizacaoCalendar !== "confirmada" &&
                resultadoReagendamento.sincronizacaoCalendar !== "sem_alteracao") {
              throw new Error("Sincronização pendente de confirmação. Não tente criar outra reserva.");
            }
            sessionStorage.removeItem(operacaoKey);
            localStorage.setItem("dataAgendamento", data);
            localStorage.setItem("horaAgendamento", horario);
            localStorage.setItem("nomeCliente", payloadWebhook.nomeCliente);
            window.location.href = origemAdmin
              ? "admin-agendamentos.html"
              : "confirmacao.html";
            return;
          }
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
        window.alert(reagendarId
          ? (error?.message || "Não foi possível confirmar o reagendamento.")
          : "Erro ao salvar agendamento.");
        botaoAgendar.disabled = false;
        botaoAgendar.classList.remove("agendamento-button--disabled");
        botaoAgendar.textContent = reagendarId
          ? "Verificar reagendamento"
          : "Confirmar Agendamento";
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

      await renderizarHorarios(dataIso, serviceDuration, reagendarId, serviceInfo);
    }
  }

  if (!reagendarId && !origemAdmin) {
    void carregarSugestoesHorarios({ datas, serviceDuration, serviceInfo, selecionarDataAgendamento });
  }

  let ultimaAtualizacaoVisibilidade = 0;
  const atualizarAoRetornar = () => {
    if (document.visibilityState !== "visible") return;
    const agora = Date.now();
    if (agora - ultimaAtualizacaoVisibilidade < 1000) return;
    ultimaAtualizacaoVisibilidade = agora;
    const dataAtiva = obterDataIso(
      obterSelecionado(datas, "agendamento-date--active") || datas[0],
    );
    if (dataAtiva) void renderizarHorarios(dataAtiva, serviceDuration, reagendarId, serviceInfo);
  };
  window.addEventListener("pageshow", atualizarAoRetornar);
  document.addEventListener("visibilitychange", atualizarAoRetornar);

  atualizarResumoAgendamento();
}

document.addEventListener("DOMContentLoaded", inicializarAgendamento);

