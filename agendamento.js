import { trackEvent } from "./analytics.js";
import { auth, db } from "./firebase-config.js";
import { webhookUrl } from "./config.js";
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

const appConfig = { webhookUrl };

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
  const dia =
    botaoData.querySelector(".agendamento-date-day")?.textContent.trim() || "";
  const semana =
    botaoData.querySelector(".agendamento-date-label")?.textContent.trim() ||
    "";
  return `${dia} ${semana}`.trim();
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

function gerarCalendarioDias(container) {
  if (!container) return;
  container.innerHTML = "";
  const weekNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
  const dias = [];
  const hoje = new Date();
  let cursor = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  while (cursor.getDay() < 2 || cursor.getDay() > 6) {
    cursor.setDate(cursor.getDate() + 1);
  }
  while (dias.length < 5) {
    const dayNum = cursor.getDate();
    const dayLabel = weekNames[cursor.getDay()];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "agendamento-date";
    btn.innerHTML = `\n      <span class="agendamento-date-day">${dayNum}</span>\n      <span class="agendamento-date-label">${dayLabel}</span>\n    `;
    container.appendChild(btn);
    try {
      btn.dataset.dateIso = cursor.toISOString().slice(0, 10);
    } catch (e) {
      const isoFallback = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate(),
      )
        .toISOString()
        .slice(0, 10);
      btn.dataset.dateIso = isoFallback;
    }
    dias.push(btn);
    cursor.setDate(cursor.getDate() + 1);
    while (cursor.getDay() < 2 || cursor.getDay() > 6) {
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  if (dias[0]) {
    dias[0].classList.add("agendamento-date--active");
    dias[0].setAttribute("aria-pressed", "true");
    localStorage.setItem("dataAgendamento", formatarData(dias[0]));
  }
}

function aguardarRedirecionamento(botao) {
  botao.textContent = "Agendando...";
  botao.disabled = true;
  botao.classList.add("agendamento-button--disabled");
}

async function carregarServicoSelecionado(serviceId) {
  const titleElement = document.querySelector(".agendamento-title");
  if (!titleElement) return null;
  document.getElementById("service-name")?.remove();
  const detailElement = document.createElement("p");
  detailElement.id = "service-name";
  detailElement.className = "agendamento-service-name";
  detailElement.textContent = "Carregando serviço...";
  titleElement.insertAdjacentElement("afterend", detailElement);
  if (!serviceId) {
    detailElement.textContent = "Serviço não especificado.";
    return null;
  }
  try {
    const servicoRef = doc(db, "servicos", serviceId);
    const servicoSnap = await getDoc(servicoRef);
    if (!servicoSnap.exists) {
      detailElement.textContent = "Serviço não encontrado no sistema.";
      return null;
    }
    const serviceData = servicoSnap.data();
    const nomeServico = serviceData.nome || "Serviço selecionado";
    const duracao = serviceData.duracao || 60;
    detailElement.textContent = nomeServico;
    return { nome: nomeServico, duracao };
  } catch (error) {
    console.error("Erro ao carregar serviço:", error);
    detailElement.textContent = "Erro ao carregar o serviço.";
    return null;
  }
}

async function renderizarHorarios(dataIso, servicoDuracao) {
  const container = document.querySelector(".agendamento-times");
  if (!container || !dataIso) {
    console.error("Erro: Contêiner de horários ou DataISO não encontrados.");
    return;
  }

  container.innerHTML = `<div class="loading">Buscando vagas...</div>`;

  try {
    const q = query(
      collection(db, "agendamentos"),
      where("data", "==", String(dataIso).trim()),
    );
    const querySnapshot = await getDocs(q);

    const intervalosOcupados = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      if (
        data.horario &&
        (!data.status ||
          ["agendado", "reagendado", "confirmado"].includes(data.status))
      ) {
        const start = timeToMins(data.horario);
        intervalosOcupados.push({ start, end: start + (data.duracao || 60) });
      }
    });

    const estaLivre = querySnapshot.size === 0;
    const minAbertura = timeToMins("09:00");
    const minFechamento = timeToMins("18:00");
    const step = 60;

    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    for (let atual = minAbertura; atual < minFechamento; atual += 60) {
      const horarioTexto = minsToTime(atual);
      const fimBloco = atual + 60;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agendamento-time";
      btn.textContent = horarioTexto;

      let indisponivel =
        !estaLivre &&
        intervalosOcupados.some((appt) => {
          const conflito = atual < appt.end && fimBloco > appt.start;
          if (conflito)
            console.log(`Horário ${horarioTexto} bloqueado por conflito.`);
          return conflito;
        });

      if (indisponivel) {
        btn.classList.add("horario-ocupado");
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      } else {
        btn.style.cursor = "pointer";
        btn.onclick = function () {
          console.log("Horário selecionado: " + horarioTexto);
          const todos = Array.from(
            container.querySelectorAll(".agendamento-time"),
          );
          selecionarUnico(btn, todos, "agendamento-time--active");
          localStorage.setItem("horarioAgendamento", horarioTexto);
          localStorage.setItem("horaAgendamento", horarioTexto);
        };
      }
      fragment.appendChild(btn);
    }
    container.appendChild(fragment);
    console.log("Horários renderizados com sucesso!");

    const salvo = localStorage.getItem("horarioAgendamento");
    if (salvo) {
      const slotValido = Array.from(
        container.querySelectorAll(".agendamento-time:not([disabled])"),
      ).find((b) => b.textContent === salvo);
      if (!slotValido) localStorage.removeItem("horarioAgendamento");
      else slotValido.classList.add("agendamento-time--active");
    }
  } catch (error) {
    console.error("Erro no renderizarHorarios:", error);
    container.innerHTML = `<p>Erro ao carregar horários.</p>`;
  }
}

async function inicializarAgendamento() {
  const calendarContainer = document.querySelector(".agendamento-calendar");
  gerarCalendarioDias(calendarContainer);
  const datas = Array.from(document.querySelectorAll(".agendamento-date"));
  const botaoAgendar = document.querySelector(".agendamento-button");
  console.log('Botão localizado:', !!botaoAgendar);
  const textareaComentarios = document.querySelector("#agendamento-notes");
  const urlParams = new URLSearchParams(window.location.search);
  if (!botaoAgendar) {
    console.error('Botão agendar não encontrado no DOM!');
  }
  const serviceId = urlParams.get("id");
  const reagendarId = urlParams.get("reagendar");

  if (!botaoAgendar || datas.length === 0 || !textareaComentarios) return;

  localStorage.removeItem("horarioAgendamento");
  const serviceInfo = await carregarServicoSelecionado(serviceId);
  const serviceName = serviceInfo?.nome || "Manicure Simples";
  const serviceDuration = serviceInfo?.duracao || 60;

  preencherNomeClienteDoLocalStorage();

  datas.forEach((botao) => {
    botao.addEventListener("click", () => {
      selecionarUnico(botao, datas, "agendamento-date--active");
      localStorage.setItem("dataAgendamento", formatarData(botao));
      const dataIso = obterDataIso(botao);
      if (dataIso) localStorage.setItem("dataAgendamentoISO", dataIso);
      renderizarHorarios(dataIso, serviceDuration);
    });
  });

  const horariosContainer = document.querySelector(".agendamento-times");
  if (horariosContainer) {
    horariosContainer.addEventListener("click", (event) => {
      const botao = event.target.closest(".agendamento-time");
      if (!botao || botao.classList.contains("horario-ocupado")) return;
      const todosHorarios = Array.from(
        horariosContainer.querySelectorAll(".agendamento-time"),
      );
      selecionarUnico(botao, todosHorarios, "agendamento-time--active");
      localStorage.setItem("horarioAgendamento", botao.textContent.trim());
    });
  }

  onAuthStateChanged(auth, (user) => {
    console.log('Autenticação verificada. Usuário:', user ? user.uid : 'Nenhum usuário logado');
    if (!user) return;

    const nomeInput = document.getElementById("nomeCliente");
    if (nomeInput) {
      const nomeUsuarioSalvo = localStorage.getItem("nomeUsuario");
      console.log("[agendamento] Nome salvo no localStorage:", nomeUsuarioSalvo);
      console.log("[agendamento] Nome no Firebase Auth:", user.displayName);
      
      // Prioridade 1: Nome salvo em meu-perfil (mais confiável)
      const nomePerfil = nomeUsuarioSalvo || user.displayName || user.email || "";
      if (nomePerfil) {
        nomeInput.value = nomePerfil;
        console.log("[agendamento] ✅ Nome carregado no campo:", nomePerfil);
      }
    }

    botaoAgendar.addEventListener("click", async () => {
      console.log('Evento de clique disparado!');
      console.log('Botão clicado. Estado do botão:', botaoAgendar.disabled ? 'Desabilitado' : 'Habilitado');
      if (botaoAgendar.disabled) return;
      const horarioSalvo = localStorage.getItem("horarioAgendamento");
      const dataAgendamentoISO = localStorage.getItem("dataAgendamentoISO");
      const horarioNormalizado = String(horarioSalvo || "")
        .toLowerCase()
        .replace(/(am|pm)/g, "")
        .trim();

      const dataSelecionada = document.querySelector(".agendamento-date--active");
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

      const nomeInput = document.getElementById('nomeCliente') || document.querySelector('input[name="nome"]');
      const nomeCliente = nomeInput ? nomeInput.value : 'Nome não informado';
      const servico = serviceName;
      const data = dataAgendamentoISO;
      const horario = horarioNormalizado;
      const observacoes = textareaComentarios?.value?.trim() || "";
      
      console.log('[agendamento] Confirmando agendamento com dados:', {
        nomeCliente,
        servico,
        serviceId,
        data,
        horario,
        observacoes
      });

      localStorage.setItem('servicoAgendamento', serviceName);
      localStorage.setItem('observacoesAgendamento', textareaComentarios?.value?.trim() || "");
      if (nomeCliente && nomeCliente.trim()) {
        localStorage.setItem('nomeUsuario', nomeCliente.trim());
      }

      if (!servico || !data || !horario) {
        console.error("[agendamento] ERRO: Dados incompletos para envio!", { servico, data, horario });
        return;
      }

      const payload = {
        nomeCliente,
        servico,
        data,
        horario,
        observacoes,
        idServico: serviceId || null,
      };

      try {
        if (reagendarId) {
          await updateDoc(doc(db, "agendamentos", reagendarId), payload);
        } else {
          const agendamentoData = {
            ...payload,
            clienteId: user.uid,
            dataCriacao: serverTimestamp(),
            status: "agendado",
          };
          console.log("[agendamento] Salvando novo agendamento com dados:", agendamentoData);
          await addDoc(collection(db, "agendamentos"), agendamentoData);
          console.log("[agendamento] ✅ Agendamento salvo com sucesso para clienteId:", user.uid);
        }

        const payloadWebhook = {
          nomeCliente,
          servico,
          dataInicio: `${data}T${horario}:00`,
          duracaoMinutos: parseInt(serviceDuration, 10) || 60,
        };

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadWebhook),
        });
        console.log('Webhook enviado com sucesso:', payloadWebhook);

        localStorage.setItem('dataAgendamento', data);
        localStorage.setItem('horaAgendamento', horario);

        window.location.href = "confirmacao.html";
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
  if (diaAtivo) renderizarHorarios(obterDataIso(diaAtivo), serviceDuration);
}

document.addEventListener("DOMContentLoaded", inicializarAgendamento);
