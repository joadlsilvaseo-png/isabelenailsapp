import { auth } from "./firebase-config.js";

document.addEventListener("DOMContentLoaded", () => {
  const confCliente = document.getElementById("conf-cliente");

  const confServico = document.getElementById("conf-servico");

  const confData = document.getElementById("conf-data");

  const confHorario = document.getElementById("conf-horario");

  const confObservacoes = document.getElementById("confirmacao-observacoes");

  const observacoesRow = document.getElementById("observacoes-row");

  const successTitle = document.getElementById("confirmacao-success-title");

  const btnWhatsapp = document.getElementById("btn-whatsapp");

  const messageElement = document.getElementById("confirmacao-message");
  const eyebrow = document.getElementById("confirmacao-eyebrow");
  const intro = document.getElementById("confirmacao-intro");
  const statusBadge = document.getElementById("confirmacao-status");

  const urlParams = new URLSearchParams(window.location.search);

  function getUrlParam(name, fallback = "") {
    return urlParams.get(name) || fallback;
  }

  function formatarDataConfirmacao(value) {
    const dataOriginal = String(value || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataOriginal)) {
      return dataOriginal || "--/--";
    }

    const [ano, mes, dia] = dataOriginal.split("-").map(Number);

    const data = new Date(ano, mes - 1, dia, 12, 0, 0);

    const dataFormatada = new Intl.DateTimeFormat("pt-BR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
    }).format(data);

    return dataFormatada.charAt(0).toUpperCase() + dataFormatada.slice(1);
  }

  function obterPrimeiroNome(nomeCompleto) {
    const primeiroNome = String(nomeCompleto || "")
      .trim()
      .split(/\s+/)[0];

    return primeiroNome || "";
  }

  function mostrarMensagem(mensagem, tipo = "normal") {
    if (!messageElement) return;

    messageElement.textContent = mensagem;
    messageElement.hidden = !mensagem;

    messageElement.classList.toggle("is-error", tipo === "erro");
  }

  function moedaCentavos(valor) {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
      .format(Number(valor || 0) / 100);
  }

  async function carregarConfirmacaoPix(reservaId) {
    try {
      const usuario = auth.currentUser;
      if (!usuario) throw new Error("Entre na sua conta para consultar o agendamento.");
      const token = await usuario.getIdToken();
      const resposta = await fetch("/api/pix/agendamento/confirmacao", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reservaId }),
        cache: "no-store"
      });
      const dados = await resposta.json();
      if (!resposta.ok) throw new Error(dados.erro || "Falha ao consultar agendamento.");
      if (!dados.agendamentoConfirmado) {
        if (successTitle) successTitle.textContent = "Pagamento em verificação";
        if (eyebrow) eyebrow.textContent = "Aguardando confirmação";
        if (intro) intro.textContent = "Assim que o backend confirmar o pagamento e o horário, os detalhes serão exibidos aqui.";
        if (statusBadge) statusBadge.lastChild.textContent = " Aguardando confirmação do PIX.";
        mostrarMensagem("O pagamento ainda não confirmou o agendamento. Esta página será atualizada quando a confirmação estiver disponível.");
        setTimeout(() => carregarConfirmacaoPix(reservaId), 5000);
        return;
      }
      if (confCliente) confCliente.textContent = dados.cliente;
      if (confServico) confServico.textContent = dados.servico;
      if (confData) confData.textContent = formatarDataConfirmacao(dados.data);
      if (confHorario) confHorario.textContent = dados.horario;
      if (successTitle) successTitle.textContent = "Agendamento confirmado!";
      if (eyebrow) eyebrow.textContent = "Pagamento identificado";
      if (intro) intro.textContent = "Seu pagamento foi identificado e seu horário está confirmado com a Isabele Mariana Nails.";
      if (statusBadge) statusBadge.lastChild.textContent = dados.statusFinanceiro === "estornado"
        ? " Pagamento PIX estornado — atendimento confirmado."
        : " Sinal PIX recebido — Agendamento confirmado.";
      const finance = [
        ["confirmacao-total-row", "conf-total", dados.valorTotalCentavos],
        ["confirmacao-sinal-row", "conf-sinal", dados.sinalPagoCentavos],
        ["confirmacao-restante-row", "conf-restante", dados.valorRestanteCentavos]
      ];
      for (const [rowId, valueId, value] of finance) {
        const row = document.getElementById(rowId);
        const field = document.getElementById(valueId);
        if (row && field) { field.textContent = moedaCentavos(value); row.hidden = false; }
      }
      mostrarMensagem("");
    } catch (erro) {
      mostrarMensagem("Não foi possível validar a confirmação agora. Seus dados serão consultados novamente.");
      setTimeout(() => carregarConfirmacaoPix(reservaId), 8000);
    }
  }

  const nomeClienteTexto =
    localStorage.getItem("nomeCliente") ||
    localStorage.getItem("nomeUsuario") ||
    getUrlParam("nome");

  const nomeServico =
    localStorage.getItem("servicoAgendamento") ||
    getUrlParam("servico", "Serviço selecionado");

  const dataOriginal =
    localStorage.getItem("dataAgendamento") || getUrlParam("data", "--/--");

  const dataTexto = formatarDataConfirmacao(dataOriginal);

  const horarioTexto =
    localStorage.getItem("horaAgendamento") ||
    localStorage.getItem("horarioAgendamento") ||
    getUrlParam("horario", "--:--");

  const observacoesTexto =
    localStorage.getItem("observacoesAgendamento") ||
    getUrlParam("observacoes");

  if (confCliente) {
    confCliente.textContent = nomeClienteTexto || "Cliente não informado";
  }

  if (confServico) {
    confServico.textContent = nomeServico || "Serviço selecionado";
  }

  if (confData) {
    confData.textContent = dataTexto || "--/--";
  }

  if (confHorario) {
    confHorario.textContent = horarioTexto || "--:--";
  }

  const observacoesValidas = Boolean(String(observacoesTexto || "").trim());

  if (observacoesRow) {
    observacoesRow.hidden = !observacoesValidas;
  }

  if (confObservacoes && observacoesValidas) {
    confObservacoes.textContent = observacoesTexto.trim();
  }

  const primeiroNome = obterPrimeiroNome(nomeClienteTexto);

  if (successTitle && primeiroNome) {
    successTitle.textContent = `Tudo certo, ${primeiroNome}!`;
  }

  const agendamentoSemPix = localStorage.getItem("isabeleAgendamentoSemPix") === "true";
  const reservaPixId = agendamentoSemPix ? null : localStorage.getItem("isabelePixReservaId");
  if (reservaPixId) {
    if (successTitle) successTitle.textContent = "Verificando pagamento";
    if (eyebrow) eyebrow.textContent = "Confirmação PIX";
    if (intro) intro.textContent = "Consultando o estado atualizado do pagamento e do agendamento.";
    carregarConfirmacaoPix(reservaPixId);
  }

  if (agendamentoSemPix) {
    localStorage.removeItem("isabeleAgendamentoSemPix");
    localStorage.removeItem("isabeleAgendamentoSemPixId");
    localStorage.removeItem("isabelePixReservaId");
  }

  if (agendamentoSemPix) {
    if (successTitle) successTitle.textContent = "Agendamento confirmado!";
    if (eyebrow) eyebrow.textContent = "Agendamento confirmado";
    if (intro) intro.textContent = "Seu horário foi confirmado sem pagamento antecipado, conforme a autorização da Isabele Mariana Nails.";
    if (statusBadge) statusBadge.lastChild.textContent = " Agendamento confirmado sem sinal PIX.";
  }

  if (btnWhatsapp) {
    const numeroWhatsSalao = "5511949494062";

    btnWhatsapp.addEventListener("click", () => {
      const linhasMensagem = [
        "Olá, Isabele! Gostaria de enviar os dados do meu agendamento:",
        "",
        `Cliente: ${nomeClienteTexto || "Não informado"}`,
        `Serviço: ${nomeServico || "Não informado"}`,
        `Data: ${dataTexto || "Não informada"}`,
        `Horário: ${horarioTexto || "Não informado"}`,
      ];

      if (observacoesValidas) {
        linhasMensagem.push(`Observações: ${observacoesTexto.trim()}`);
      }

      linhasMensagem.push("", "Obrigada!");

      const mensagem = linhasMensagem.join("\n");

      const urlWhatsapp =
        `https://wa.me/${numeroWhatsSalao}` +
        `?text=${encodeURIComponent(mensagem)}`;

      const novaJanela = window.open(
        urlWhatsapp,
        "_blank",
        "noopener,noreferrer",
      );

      if (!novaJanela) {
        mostrarMensagem(
          "O navegador bloqueou a abertura do WhatsApp. Permita pop-ups e tente novamente.",
          "erro",
        );
      }
    });
  }
});
