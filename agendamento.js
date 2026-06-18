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

function validarAgendamento(data, hora) {
  if (!data || !hora) return false;

  const dataOk = /^\d{4}-\d{2}-\d{2}$/.test(data);
  const horaOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(hora);

  return dataOk && horaOk;
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
async function verificarHorariosOcupados(dataIso) {
  if (!dataIso) return;

  try {
    const dateKey = String(dataIso).trim();
    // Removido: console.log("DEBUG: Buscando data no Firestore exatamente como:", `"${dateKey}"`);

    const q = query(
      collection(db, "agendamentos"),
      where("data", "==", dateKey),
    );
    console.log("Consultando Firestore para data:", dateKey);
    const querySnapshot = await getDocs(q);
    console.log("Documentos encontrados:", querySnapshot.size);

    const horariosOcupados = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();

      // REGRA: Apenas agendamentos com intenção de execução bloqueiam o horário.
      // Horários 'concluidos' ou 'realizados' liberam o slot para novos atendimentos.
      const statusAtivos = ["agendado", "reagendado", "confirmado"];

      const isOcupado =
        data &&
        data.horario &&
        (!data.status || statusAtivos.includes(data.status));

      if (isOcupado) {
        horariosOcupados.push(String(data.horario).trim());
      }
    });

    const horarios = Array.from(document.querySelectorAll(".agendamento-time"));
    limparHorariosOcupados(horarios);

    horariosOcupados.forEach((horaDB) => {
      // 1. Limpa o que vem do Banco
      const dbRaw = String(horaDB).trim().toLowerCase();

      // 2. Procura no DOM (usando 'horarios' que é a variável definida no escopo)
      const slotEncontrado = horarios.find((s) => {
        const btnRaw = String(s.textContent).trim().toLowerCase();

        // Compara se um está contido no outro (mais tolerante a formatos como '9:00' e '09:00')
        return btnRaw.includes(dbRaw) || dbRaw.includes(btnRaw);
      });

      if (slotEncontrado) {
        slotEncontrado.classList.add("horario-ocupado");
        slotEncontrado.disabled = true;
        slotEncontrado.setAttribute("aria-disabled", "true");

        // UX: Se o horário ocupado era o que estava ativo, removemos a seleção
        if (slotEncontrado.classList.contains("agendamento-time--active")) {
          slotEncontrado.classList.remove("agendamento-time--active");
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
  const reagendarId = urlParams.get("reagendar");

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
      localStorage.setItem("dataAgendamento", formatarData(botao));
      // Salva também a versão ISO técnica para integrações
      const dataIso = obterDataIso(botao);
      if (dataIso) localStorage.setItem("dataAgendamentoISO", dataIso);
      verificarHorariosOcupados(dataIso);
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

      // Captura os valores direto do DOM ou do localStorage
      const dataAgendamentoISO = localStorage.getItem("dataAgendamentoISO");
      const horarioSalvo =
        localStorage.getItem("horarioAgendamento") ||
        (horarioSelecionado ? horarioSelecionado.textContent : "");

      // Normalização mínima do horário para evitar crashes
      const horarioNormalizado = String(horarioSalvo)
        .toLowerCase()
        .replace(/(am|pm)/g, "")
        .trim();

      // Validação usando a função simples
      if (!validarAgendamento(dataAgendamentoISO, horarioNormalizado)) {
        window.alert(
          "Por favor, selecione uma data e um horário válidos antes de prosseguir.",
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
      const observacoesValor =
        textareaComentarios.value.trim() || "sem observações";

      // Montagem da data no formato ISO
      const dataHoraObj = new Date(
        `${dataAgendamentoISO}T${horarioNormalizado}:00`,
      );

      if (isNaN(dataHoraObj.getTime())) {
        console.error("Data inválida no agendamento:", {
          dataAgendamentoISO,
          horarioNormalizado,
        });
        botaoAgendar.disabled = false;
        botaoAgendar.textContent = "Confirmar Agendamento";
        botaoAgendar.classList.remove("agendamento-button--disabled");
        return;
      }

      const dataSalva = dataAgendamentoISO;
      // O horarioSalvo para o payload será o normalizado
      const horarioFinal = horarioNormalizado;

      // Lembrete 24h antes
      const reminder24h = new Date(dataHoraObj.getTime() - 24 * 60 * 60 * 1000);
      // Lembrete 2h antes
      const reminder2h = new Date(dataHoraObj.getTime() - 2 * 60 * 60 * 1000);

      // REGRA DE NEGÓCIO: Dados básicos do agendamento (editáveis)
      const payload = {
        idServico: serviceId,
        servico: serviceName,
        data: dataSalva,
        dataISO: dataAgendamentoISO,
        horario: horarioFinal,
        duracao: serviceDuration,
        observacoes: observacoesValor,
        status: reagendarId ? "reagendado" : "agendado", // Status inicial
        reminder_24h: reminder24h.toISOString(),
        reminder_2h: reminder2h.toISOString(),
        email_lembrete_24h: false,
        lembrete_email_1hr: false,
      };

      try {
        let finalDocId = reagendarId;
        let targetClientId = userId;

        if (reagendarId) {
          // REAGENDAMENTO: Atualiza apenas campos de horário/status. clienteId permanece o original do doc.
          const docRef = doc(db, "agendamentos", reagendarId);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            targetClientId = snap.data().clienteId || snap.data().idCliente;
          }

          await updateDoc(doc(db, "agendamentos", reagendarId), payload);
          console.log("Agendamento REAGENDADO com SUCESSO! ID:", reagendarId);

          // Grava evento de notificação para Reagendamento
          await addDoc(collection(db, "eventos_notificacao"), {
            tipo: "agendamento_reagendado",
            clienteId: targetClientId,
            agendamentoId: reagendarId,
            processado: false,
            timestamp: new Date().toISOString(),
          });
        } else {
          // NOVO AGENDAMENTO: Define clienteId e data de criação (campos imutáveis)
          const novoPayload = {
            ...payload,
            clienteId: userId,
            dataCriacao: serverTimestamp(),
          };
          const docRef = await addDoc(
            collection(db, "agendamentos"),
            novoPayload,
          );
          finalDocId = docRef.id;
          console.log("Agendamento salvo com SUCESSO! ID:", finalDocId);

          // Grava evento de notificação para Novo Agendamento
          await addDoc(collection(db, "eventos_notificacao"), {
            tipo: "agendamento_criado",
            clienteId: userId,
            agendamentoId: finalDocId,
            processado: false,
            timestamp: new Date().toISOString(),
          });
        }

        // Sincroniza os horários ocupados imediatamente após o sucesso do agendamento
        await verificarHorariosOcupados(dataAgendamentoISO);

        // 1.1 Rastreamento do GA4
        trackEvent("agendamento_concluido", {
          servico: serviceName,
          horario: horarioFinal,
        });

        // 2. Dispara webhook do Make em background (não bloqueia o redirecionamento)
        (async () => {
          try {
            const payloadToSend = {
              ...payload,
              clienteId: targetClientId, // Garante que o ID do cliente original seja enviado
              email: user.email, // Email do usuário logado
              servico: serviceName || "Manicure Simples",
              idAgendamento: finalDocId,
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
        const horarioUrl = encodeURIComponent(horarioFinal);

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
    verificarHorariosOcupados(obterDataIso(diaAtivo));
  }
}

// Inicializa o script quando a página carregar
document.addEventListener("DOMContentLoaded", inicializarAgendamento);
