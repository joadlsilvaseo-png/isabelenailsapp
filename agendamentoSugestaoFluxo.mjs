/**
 * Trava SOMENTE a seleção manual dos turnos depois de uma sugestão válida.
 * Marcadores próprios permitem restaurar exclusivamente botões anteriormente
 * disponíveis, sem liberar horários originalmente ocupados ou bloqueados.
 */
export function definirBloqueioTurnos(container, bloquear, verIndisponiveis = null) {
  if (!container) return;
  const ativo = bloquear === true;
  container.classList.toggle("agendamento-times--sugestao-selecionada", ativo);
  for (const botao of container.querySelectorAll(".agendamento-time")) {
    if (ativo) {
      if (botao.disabled) continue;
      botao.disabled = true;
      botao.dataset.bloqueioSugestao = "true";
      botao.setAttribute("aria-disabled", "true");
    } else if (botao.dataset.bloqueioSugestao === "true") {
      botao.disabled = false;
      delete botao.dataset.bloqueioSugestao;
      botao.removeAttribute("aria-disabled");
    }
  }
  if (verIndisponiveis) verIndisponiveis.disabled = ativo;
}
