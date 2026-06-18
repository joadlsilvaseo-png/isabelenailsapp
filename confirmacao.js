document.addEventListener("DOMContentLoaded", () => {
  // 1. Mapeia os elementos do HTML
  const confServico = document.getElementById("conf-servico");
  const confData = document.getElementById("conf-data");
  const confHorario = document.getElementById("conf-horario");
  const btnWhatsapp = document.getElementById("btn-whatsapp");

  // 2. Lê os parâmetros direto da URL do navegador
  const urlParams = new URLSearchParams(window.location.search);

  // O decodeURIComponent serve para tirar os "%20" e transformar em espaços normais
  const nomeServico = decodeURIComponent(
    urlParams.get("servico") || "Manicure Simples",
  );
  const dataTexto = decodeURIComponent(urlParams.get("data") || "--/--");
  const horarioTexto = decodeURIComponent(urlParams.get("horario") || "--:--");

  console.log("Dados extraídos da URL:", {
    nomeServico,
    dataTexto,
    horarioTexto,
  });

  // 3. Injeta os dados nos spans do HTML
  if (confServico) confServico.textContent = nomeServico;
  if (confData) confData.textContent = dataTexto;
  if (confHorario) confHorario.textContent = horarioTexto;

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
