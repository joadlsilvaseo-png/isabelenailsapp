/* Continuação de agendamento iniciada no catálogo público do site. */
/* Não aceita URLs livres; apenas IDs de documentos Firestore para impedir redirecionamentos externos. */
export function validarServicoCatalogo(value) {
  const raw = typeof value === "string" ? value : "";
  if (!raw || raw.length > 300 || !raw.trim() || /[\\/\?#\u0000-\u001f\u007f]/.test(raw)) return "";
  return raw;
}
export function servicoCatalogoDaUrl(search = "") {
  const params = new URLSearchParams(search);
  return validarServicoCatalogo(params.get("servico"));
}
function rotaComServico(base, id) {
  const validated = validarServicoCatalogo(id);
  return validated ? base + "?servico=" + encodeURIComponent(validated) : base;
}
export const loginComServico = id => rotaComServico("login.html", id);
export const registroComServico = id => rotaComServico("registro.html", id);
export const principalComServico = id => rotaComServico("principal.html", id);
export function agendamentoComServico(id) {
  const validated = validarServicoCatalogo(id);
  return validated ? "agendamento.html?id=" + encodeURIComponent(validated) : "principal.html#services-title";
}
