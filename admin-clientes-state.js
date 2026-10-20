export async function salvarIsencaoComReversao({ uid, ativa, salvar, aplicarEstado, informar }) {
  try {
    const resultado = await salvar(uid, ativa);
    if (resultado?.clienteUid !== uid || resultado?.ativa !== ativa) {
      throw new Error("O servidor não confirmou a alteração.");
    }
    informar(ativa ? "Autorização ativa." : "Autorização revogada.", "success");
    return true;
  } catch (error) {
    aplicarEstado(!ativa);
    informar(`${error.message || "Não foi possível salvar a autorização."} O controle foi revertido.`, "error");
    return false;
  }
}
