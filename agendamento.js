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
    // ADICIONE ISSO PARA DEBUGAR:
    console.log(
      "Data que estamos buscando no Firebase:",
      String(dataIso).trim(),
    );
    console.log("Quantos documentos foram encontrados:", querySnapshot.size);

    querySnapshot.forEach((doc) => {
      console.log("Documento encontrado:", doc.data());
    });

    const intervalosOcupados = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();

      // Defina os status que realmente ocupam a agenda
      const statusValidos = ["agendado", "reagendado", "confirmado"];

      // Verifica se tem horário e se o status está na lista de válidos
      if (data.horario && statusValidos.includes(data.status)) {
        const start = timeToMins(data.horario);

        // Se existir data.duracao, usamos. Caso contrário, usamos 90 apenas como fallback para legados.
        const duracaoDoAgendamento = data.duracao ? Number(data.duracao) : 90;

        intervalosOcupados.push({ start, end: start + duracaoDoAgendamento });
        console.log(
          `[DEBUG] Bloqueando horário ${data.horario} (Duração: ${duracaoDoAgendamento} min).`,
        );
      } else {
        console.log(
          `[DEBUG] Ignorando agendamento ${data.horario} (Status: ${data.status})`,
        );
      }
    });

    const estaLivre = querySnapshot.size === 0;
    const minAbertura = timeToMins("09:00");
    const minFechamento = timeToMins("18:00");

    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    // Loop de 30 em 30 min para melhor granularidade, usando a duração do serviço
    for (let atual = minAbertura; atual < minFechamento; atual += 30) {
      const horarioTexto = minsToTime(atual);
      const fimBloco = atual + servicoDuracao;

      // Se o serviço terminar após o horário de fechamento, para o loop
      if (fimBloco > minFechamento) break;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agendamento-time";
      btn.textContent = horarioTexto;

      // A lógica agora é: ocupado se conflita com agendamento OU se termina após o horário limite
      // Corrigimos para garantir que o conflito seja detectado corretamente
      let indisponivel = intervalosOcupados.some((appt) => {
        const conflito =
          atual < appt.end && atual + servicoDuracao > appt.start;
        return conflito;
      });

      // Se o bloco ultrapassa o limite de funcionamento (ex: 18:00)
      if (atual + servicoDuracao > minFechamento) {
        indisponivel = true;
      }

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
  console.log("Botão localizado:", !!botaoAgendar);
  const textareaComentarios = document.querySelector("#agendamento-notes");
  const urlParams = new URLSearchParams(window.location.search);
  if (!botaoAgendar) {
    console.error("Botão agendar não encontrado no DOM!");
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
    console.log(
      "Autenticação verificada. Usuário:",
      user ? user.uid : "Nenhum usuário logado",
    );
    if (!user) return;

    const nomeInput = document.getElementById("nomeCliente");
    if (nomeInput) {
      const nomeUsuarioSalvo = localStorage.getItem("nomeUsuario");
      console.log(
        "[agendamento] Nome salvo no localStorage:",
        nomeUsuarioSalvo,
      );
      console.log("[agendamento] Nome no Firebase Auth:", user.displayName);

      // Prioridade 1: Nome salvo em meu-perfil (mais confiável)
      const nomePerfil =
        nomeUsuarioSalvo || user.displayName || user.email || "";
      if (nomePerfil) {
        nomeInput.value = nomePerfil;
        console.log("[agendamento] ✅ Nome carregado no campo:", nomePerfil);
      }
    }

    botaoAgendar.addEventListener("click", async () => {
      console.log("Evento de clique disparado!");
      console.log(
        "Botão clicado. Estado do botão:",
        botaoAgendar.disabled ? "Desabilitado" : "Habilitado",
      );
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

      console.log("[agendamento] Confirmando agendamento com dados:", {
        nomeCliente,
        servico,
        serviceId,
        data,
        horario,
        observacoes,
      });

      localStorage.setItem("servicoAgendamento", serviceName);
      localStorage.setItem(
        "observacoesAgendamento",
        textareaComentarios?.value?.trim() || "",
      );
      if (nomeCliente && nomeCliente.trim()) {
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
            duracao: parseInt(serviceDuration, 10), // AQUI GARANTIMOS O SALVAMENTO
            clienteId: user.uid,
            dataCriacao: serverTimestamp(),
            status: "agendado",
          };
          console.log(
            "[agendamento] Salvando novo agendamento com dados:",
            agendamentoData,
          );
          await addDoc(collection(db, "agendamentos"), agendamentoData);
          console.log(
            "[agendamento] ✅ Agendamento salvo com sucesso para clienteId:",
            user.uid,
          );
        }

        const payloadWebhook = {
          nomeCliente,
          servico,
          dataInicio: `${data}T${horario}:00`,
          duracaoMinutos: parseInt(serviceDuration, 10) || 60,
        };

        // ========================================================================
        // INÍCIO: LOGS DE AUDITORIA PARA GOOGLE APPS SCRIPT (TEMPORÁRIO)
        // ========================================================================
        console.log("===== AUDITORIA DE ENVIO PARA GOOGLE APPS SCRIPT =====");

        // URL do Google Apps Script
        const googleScriptUrl =
          "https://script.google.com/macros/s/AKfycbzU9mjBQ3-RkHwShSkC6ADsrUiogFbXJs9wt8hn4YphVv7h0VsevtAhU-9fZYmWxHRQqA/exec";
        console.log(`[AUDITORIA] URL de destino: ${googleScriptUrl}`);

        console.log("[AUDITORIA] Payload completo:", payloadWebhook);
        console.log("[AUDITORIA] Verificação de Tipos:");
        console.log(
          `  - nomeCliente: '${payloadWebhook.nomeCliente}' (tipo: ${typeof payloadWebhook.nomeCliente})`,
        );
        console.log(
          `  - servico: '${payloadWebhook.servico}' (tipo: ${typeof payloadWebhook.servico})`,
        );
        console.log(
          `  - dataInicio: '${payloadWebhook.dataInicio}' (tipo: ${typeof payloadWebhook.dataInicio})`,
        );
        console.log(
          `  - duracaoMinutos: ${payloadWebhook.duracaoMinutos} (tipo: ${typeof payloadWebhook.duracaoMinutos})`,
        );

        console.log("[AUDITORIA] Verificação de Valores Críticos:");
        console.log(
          `  - Valor de serviceDuration (antes do parseInt): '${serviceDuration}' (tipo: ${typeof serviceDuration})`,
        );
        console.log(
          `  - Valor final de dataInicio: '${payloadWebhook.dataInicio}'`,
        );
        console.log(
          `  - Valor final de nomeCliente: '${payloadWebhook.nomeCliente}'`,
        );
        console.log(
          "==========================================================",
        );
        // ========================================================================
        // FIM: LOGS DE AUDITORIA
        // ========================================================================

        try {
          await fetch(googleScriptUrl, {
            method: "POST",
            mode: "no-cors", // Essencial para evitar bloqueio do navegador
            body: JSON.stringify(payloadWebhook),
          });
          console.log(
            "Dados do agendamento enviados para o Google Apps Script (requisição despachada).",
          );
        } catch (fetchError) {
          console.error(
            "[AUDITORIA] Ocorreu um erro de REDE ao tentar enviar para o Google Apps Script:",
            fetchError,
          );
          // Adiciona um alerta para o usuário em caso de falha de rede
          window.alert(
            "Falha de conexão ao tentar salvar o agendamento. Verifique sua internet e tente novamente.",
          );
        }

        localStorage.setItem("dataAgendamento", data);
        localStorage.setItem("horaAgendamento", horario);
        // Sugestão: salve o nome do cliente também para usar na tela de confirmação
        localStorage.setItem("nomeCliente", payloadWebhook.nomeCliente);

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
