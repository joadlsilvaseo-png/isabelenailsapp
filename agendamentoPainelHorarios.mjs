/**
 * Controla exclusivamente a apresentação dos horários convencionais.
 * O motor de sugestões, a disponibilidade PIX e a confirmação permanecem intactos.
 */
export function configurarPainelHorarios(botao, painel) {
  if (!botao || !painel) {
    return { recolher() {}, expandir() {}, estaAberto: () => false };
  }
  const texto = botao.querySelector("[data-horarios-toggle-texto]");
  let aberto = false;
  function aplicar(valor) {
    aberto = valor === true;
    painel.hidden = !aberto;
    botao.setAttribute("aria-expanded", String(aberto));
    if (texto) texto.textContent = aberto ? "Recolher horários" : "Ver todos os horários";
  }
  botao.addEventListener("click", () => aplicar(!aberto));
  aplicar(false);
  return {
    recolher() { aplicar(false); },
    expandir() { aplicar(true); },
    estaAberto() { return aberto; },
  };
}
