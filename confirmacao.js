document.addEventListener("DOMContentLoaded", () => {
  // 1. Mapeia os elementos do HTML
  const confCliente = document.getElementById("conf-cliente");
  const confServico = document.getElementById("conf-servico");
  const confData = document.getElementById("conf-data");
  const confHorario = document.getElementById("conf-horario");
  const confObservacoes = document.getElementById("confirmacao-observacoes");
  const btnWhatsapp = document.getElementById("btn-whatsapp");

  // 2. Lê os parâmetros direto da URL do navegador
  const urlParams = new URLSearchParams(window.location.search);

  // Tenta ler primeiro do localStorage e depois da URL
  const nomeClienteTexto =
    localStorage.getItem("nomeUsuario") ||
    decodeURIComponent(urlParams.get("nome") || "");
  const nomeServico =
    localStorage.getItem("servicoAgendamento") ||
    decodeURIComponent(urlParams.get("servico") || "Manicure Simples");
  const dataTexto =
    localStorage.getItem("dataAgendamento") ||
    decodeURIComponent(urlParams.get("data") || "--/--");
  const horarioTexto =
    localStorage.getItem("horaAgendamento") ||
    localStorage.getItem("horarioAgendamento") ||
    decodeURIComponent(urlParams.get("horario") || "--:--");
  const observacoesTexto =
    localStorage.getItem("observacoesAgendamento") ||
    decodeURIComponent(urlParams.get("observacoes") || "");

  // 3. Injeta dados nos spans do HTML quando disponíveis
  if (confCliente) confCliente.textContent = nomeClienteTexto || "Cliente não informado";
  if (confServico) confServico.textContent = nomeServico || "Manicure Simples";
  if (confData) confData.textContent = dataTexto || "--/--";
  if (confHorario) confHorario.textContent = horarioTexto || "--:--";
  if (confObservacoes)
    confObservacoes.textContent = observacoesTexto || "—";

  // 4. Configuração do Botão do WhatsApp
  if (btnWhatsapp) {
    // 🚨 COLOQUE SEU NÚMERO DE WHATSAPP REAL AQUI (Apenas números com DDD)
    const numeroWhatsSalao = "5511999999999";

    btnWhatsapp.addEventListener("click", (e) => {
      e.preventDefault();

      const textoMensagem =
        `Olá! Gostaria de enviar o comprovante do meu agendamento:%0A%0A` +
        `💅 *Serviço:* ${nomeServico}%0A` +
        `📅 *Data:* ${dataTexto}%0A` +
        `⏰ *Horário:* ${horarioTexto}%0A%0A` +
        `Obrigado(a)!`;

      const urlFinal = `https://api.whatsapp.com/send?phone=${numeroWhatsSalao}&text=${textoMensagem}`;
      window.open(urlFinal, "_blank");
    });
  }
});
