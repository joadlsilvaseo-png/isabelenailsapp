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

  if (btnWhatsapp) {
    /*
     * Substitua pelo número real da Isabele.
     * Use somente números:
     * 55 + DDD + número.
     */
    const numeroWhatsSalao = "5511949494062";

    btnWhatsapp.addEventListener("click", () => {
      if (numeroWhatsSalao === "5511999999999") {
        console.warn(
          "O número do WhatsApp ainda está usando o valor de exemplo.",
        );
      }

      const linhasMensagem = [
        "Olá, Isabele! Gostaria de enviar os dados do meu agendamento:",
        "",
        `👤 Cliente: ${nomeClienteTexto || "Não informado"}`,
        `💅 Serviço: ${nomeServico || "Não informado"}`,
        `📅 Data: ${dataTexto || "Não informada"}`,
        `⏰ Horário: ${horarioTexto || "Não informado"}`,
      ];

      if (observacoesValidas) {
        linhasMensagem.push(`📝 Observações: ${observacoesTexto.trim()}`);
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
