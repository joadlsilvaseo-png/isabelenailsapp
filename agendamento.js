import { trackEvent } from "./analytics.js";
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

let horarioSelecionadoValue = "";

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

// Recupera o valor ISO armazenado no botão (ex: "2026-06-17")
function obterDataIso(botaoData) {
  if (!botaoData) return null;
  return botaoData.dataset?.dateIso || null;
}

// Gera exatamente 5 dias úteis (Terça a Sábado) a partir do próximo dia útil disponível
function gerarCalendarioDias(container) {
  if (!container) return;
  // limpa estritamente o container para evitar elementos fantasmas
  container.innerHTML = "";

  const weekNames = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
  const dias = [];
  const hoje = new Date();

  // Encontra o primeiro dia útil (pode ser hoje se for Ter-Sab)
  let cursor = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  // avança até que seja Terça(2) a Sábado(6)
  while (cursor.getDay() < 2 || cursor.getDay() > 6) {
    cursor.setDate(cursor.getDate() + 1);
  }

  // Coleta exatamente 5 dias úteis (Ter a Sáb)
  while (dias.length < 5) {
    const dayNum = cursor.getDate();
    const dayLabel = weekNames[cursor.getDay()];

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "agendamento-date";
    btn.innerHTML = `\n      <span class="agendamento-date-day">${dayNum}</span>\n      <span class="agendamento-date-label">${dayLabel}</span>\n    `;

    container.appendChild(btn);
    // Armazena a data em formato ISO para integrações (ex: 2026-06-17)
    try {
      btn.dataset.dateIso = cursor.toISOString().slice(0, 10);
    } catch (e) {
      // fallback: constrói manualmente
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

    // avança para o próximo dia e pula dom/segunda
    cursor.setDate(cursor.getDate() + 1);
    while (cursor.getDay() < 2 || cursor.getDay() > 6) {
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // marca o primeiro dia como ativo por padrão e salva no localStorage
  if (dias[0]) {
    dias[0].classList.add("agendamento-date--active");
    dias[0].setAttribute("aria-pressed", "true");
    localStorage.setItem("dataAgendamento", formatarData(dias[0]));
  }
}

function exibirFeedbackBotao(botao, texto) {
  botao.textContent = texto;
}

function aguardarRedirecionamento(botao) {
  exibirFeedbackBotao(botao, "Agendando...");
  botao.disabled = true;
  botao.classList.add("agendamento-button--disabled");
}

async function carregarServicoSelecionado(serviceId) {
  const titleElement = document.querySelector(".agendamento-title");
  if (!titleElement) return null;

  // Remove indicador antigo se já existir para não duplicar na tela
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
    // Recupera duração técnica em minutos (Number). Default 60 se não existir.
    const duracao = serviceData.duracao || 60;
    detailElement.textContent = nomeServico;
    // Retorna objeto com nome e duração para uso no payload
    return { nome: nomeServico, duracao };
  } catch (error) {
    console.error("Erro ao carregar serviço:", error);
    detailElement.textContent = "Erro ao carregar o serviço.";
    return null;
  }
}

// Remove classe e reativa todas as pílulas de horário
function limparHorariosOcupados(horarios) {
  horarios.forEach((h) => {
    h.classList.remove("horario-ocupado");
    h.removeAttribute("aria-disabled");
    h.disabled = false;
  });
}

// Consulta agendamentos no Firestore para a data selecionada e marca horários ocupados
async function verificarHorariosOcupados(dataSelecionada) {
  if (!dataSelecionada) return;

  try {
    const dateKey = String(dataSelecionada).trim();
    const q = query(
      collection(db, "agendamentos"),
      where("data", "==", dateKey),
    );
    const querySnapshot = await getDocs(q);

    const horariosOcupados = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      if (data && data.horario)
        horariosOcupados.push(String(data.horario).trim());
    });

    const horarios = Array.from(document.querySelectorAll(".agendamento-time"));
    limparHorariosOcupados(horarios);

    horariosOcupados.forEach((hora) => {
      const match = horarios.find((h) => h.textContent.trim() === hora);
      if (match) {
        match.classList.add("horario-ocupado");
        match.setAttribute("aria-disabled", "true");
        match.disabled = true;
        if (match.classList.contains("agendamento-time--active")) {
          match.classList.remove("agendamento-time--active");
          localStorage.removeItem("horarioAgendamento");
        }
      }
    });
  } catch (error) {
    console.error("Erro ao verificar horários ocupados:", error);
  }
}

async function inicializarAgendamento() {
  const calendarContainer = document.querySelector(".agendamento-calendar");
  gerarCalendarioDias(calendarContainer);

  const datas = Array.from(document.querySelectorAll(".agendamento-date"));
  const horarios = Array.from(document.querySelectorAll(".agendamento-time"));
  const botaoAgendar = document.querySelector(".agendamento-button");
  const textareaComentarios = document.querySelector("#agendamento-notes");
  const urlParams = new URLSearchParams(window.location.search);
  const serviceId = urlParams.get("id");

  if (
    !botaoAgendar ||
    datas.length === 0 ||
    horarios.length === 0 ||
    !textareaComentarios
  ) {
    return;
  }

  localStorage.removeItem("horarioAgendamento");

  const serviceInfo = await carregarServicoSelecionado(serviceId);

  const serviceName = serviceInfo?.nome || "Manicure Simples";
  const serviceDuration = serviceInfo?.duracao || 60;

  datas.forEach((botao) => {
    botao.addEventListener("click", () => {
      selecionarUnico(botao, datas, "agendamento-date--active");
      const horariosList = Array.from(
        document.querySelectorAll(".agendamento-time"),
      );
      limparHorariosOcupados(horariosList);
      const dataText = formatarData(botao);
      localStorage.setItem("dataAgendamento", dataText);
      // Salva também a versão ISO técnica para integrações
      const dataIso = obterDataIso(botao);
      if (dataIso) localStorage.setItem("dataAgendamentoISO", dataIso);
      verificarHorariosOcupados(dataText);
    });
  });

  horarios.forEach((botao) => {
    botao.addEventListener("click", () => {
      if (botao.classList.contains("horario-ocupado")) return;
      selecionarUnico(botao, horarios, "agendamento-time--active");

      horarioSelecionadoValue = botao.textContent.trim();
      localStorage.setItem("horarioAgendamento", horarioSelecionadoValue);
    });
  });

  let botaoAgendarConfigurado = false;
  onAuthStateChanged(auth, (user) => {
    if (!user || !user.uid) {
      console.error("Nenhum usuário logado para realizar o agendamento.");
      return;
    }

    if (botaoAgendarConfigurado) return;
    botaoAgendarConfigurado = true;

    botaoAgendar.addEventListener("click", async () => {
      // 🛡️ Bloqueia cliques adicionais na mesma hora!
      if (botaoAgendar.disabled) return;

      const dataSelecionada = obterSelecionado(
        datas,
        "agendamento-date--active",
      );
      const horarioSelecionado = obterSelecionado(
        horarios,
        "agendamento-time--active",
      );

      // Captura os valores direto do DOM ou do localStorage para garantir
      const dataSalva = String(
        localStorage.getItem("dataAgendamento") ||
          (dataSelecionada ? formatarData(dataSelecionada) : ""),
      ).trim();
      const horarioSalvo = String(
        localStorage.getItem("horarioAgendamento") ||
          (horarioSelecionado ? horarioSelecionado.textContent : ""),
      ).trim();
      const observacoesValor =
        textareaComentarios.value.trim() || "sem observações";

      // Validação estrita antes de mexer no banco
      if (
        !dataSelecionada ||
        !horarioSelecionado ||
        !dataSalva ||
        !horarioSalvo ||
        horarioSalvo === "--:--"
      ) {
        window.alert(
          "Por favor, selecione uma data e um horário antes de prosseguir.",
        );
        return;
      }

      if (!serviceId) {
        window.alert(
          "Erro: Nenhum serviço foi selecionado. Volte e escolha um serviço.",
        );
        return;
      }

      // Muda o estado do botão para o usuário ver
      aguardarRedirecionamento(botaoAgendar);

      const userId = String(user.uid).trim();

      // Monta o payload exato para o banco de dados
      const payload = {
        idCliente: userId,
        idServico: serviceId,
        servico: serviceName, // Gravando o nome do serviço no agendamento
        data: dataSalva,
        dataISO: localStorage.getItem("dataAgendamentoISO"),
        horario: horarioSalvo,
        duracao: serviceDuration,
        observacoes: observacoesValor,
        status: "confirmado",
        email_lembrete_24h: false,
        lembrete_email_1hr: false,
        dataCriacao: serverTimestamp(),
      };

      try {
        // 1. Salva no Firestore
        const docRef = await addDoc(collection(db, "agendamentos"), payload);
        console.log("Agendamento salvo com SUCESSO! ID:", docRef.id);

        // 1.1 Rastreamento do GA4
        trackEvent("agendamento_concluido", {
          servico: serviceName,
          horario: horarioSalvo,
        });

        // 2. Dispara webhook do Make em background (não bloqueia o redirecionamento)
        (async () => {
          try {
            const payloadToSend = {
              ...payload,
              servico: serviceName || "Manicure Simples",
              idAgendamento: docRef.id,
            };

            await fetch(
              "https://hook.us2.make.com/tc2ixtft4g5cuavfsjglcvdceg16kcbc",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(payloadToSend),
              },
            );
          } catch (webhookError) {
            console.warn("Falha ao enviar webhook para o Make:", webhookError);
          }
        })();

        // 3. Transmite os dados direto pela URL (Sem depender de Storage!)
        const servicoUrl = encodeURIComponent(
          serviceName || "Manicure Simples",
        );
        const dataUrl = encodeURIComponent(dataSalva);
        const horarioUrl = encodeURIComponent(horarioSalvo);

        // Redireciona passando os dados como "presente" na URL
        window.location.href = `confirmacao.html?servico=${servicoUrl}&data=${dataUrl}&horario=${horarioUrl}`;
      } catch (error) {
        console.error("Erro no fluxo de agendamento: ", error);
        window.alert("Não foi possível salvar o agendamento.");
        botaoAgendar.disabled = false;
        botaoAgendar.textContent = "Confirmar Agendamento";
        botaoAgendar.classList.remove("agendamento-button--disabled");
      }
    });
  });

  // Mantém a verificação inicial do primeiro dia ativo funcionando
  const diaAtivo =
    obterSelecionado(datas, "agendamento-date--active") || datas[0];
  if (diaAtivo) {
    verificarHorariosOcupados(formatarData(diaAtivo));
  }
}

// Inicializa o script quando a página carregar
document.addEventListener("DOMContentLoaded", inicializarAgendamento);
