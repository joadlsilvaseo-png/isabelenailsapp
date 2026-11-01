// Orientações de escolha para os cards de serviços, sem depender de nomes fixos no catálogo.
export function servicoEhManutencao(nome) {
  const normalizado = String(nome || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return /\bmanutencao\b/.test(normalizado);
}

export function criarEtiquetaManutencao(nome) {
  if (!servicoEhManutencao(nome)) return null;

  const etiqueta = document.createElement("span");
  etiqueta.className = "service-maintenance-label";
  etiqueta.textContent = "Somente para quem já possui a aplicação";
  return etiqueta;
}
