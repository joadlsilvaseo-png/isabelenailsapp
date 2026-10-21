/**
 * Dados minimos para recuperar um perfil de cliente autenticada sem criar
 * permissoes administrativas nem afirmar aceite de termos inexistente.
 * Este modulo nao acessa Firebase, facilitando testes locais.
 */
function texto(valor, limite) {
  return typeof valor === "string" ? valor.trim().slice(0, limite) : "";
}

export function podeRecuperarPerfilCliente(usuarioData, clienteData) {
  if (clienteData) return false;
  if (!usuarioData) return true;
  return (
    String(usuarioData.role || "").trim().toLowerCase() === "cliente" &&
    usuarioData.ativo === true
  );
}

export function montarPerfilClienteAuth(
  user,
  { nomeAlternativo = "", telefoneAlternativo = "", agora = new Date() } = {},
) {
  if (!user || typeof user.uid !== "string" || !user.uid.trim()) {
    throw new Error("Conta autenticada inválida para recuperar cadastro.");
  }
  const nome = texto(user.displayName, 120) || texto(nomeAlternativo, 120) || "Cliente";
  const email = texto(user.email, 180);
  const telefone = texto(telefoneAlternativo, 50) || texto(user.phoneNumber, 50);
  const foto = texto(user.photoURL, 2048);
  return {
    nome,
    email,
    telefone,
    role: "cliente",
    dataCadastro: agora.toISOString(),
    origemCadastro: "recuperacao-auth",
    ...(foto ? { foto } : {}),
  };
}
