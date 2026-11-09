/** Interface administrativa de lembretes de amanha pelo WhatsApp Business.
 * Nao envia mensagens: o envio exige confirmacao no aplicativo WhatsApp.
 */
import { auth } from "./firebase-config.js";
import { linkWhatsApp } from "./assistenteGestaoCore.mjs";

const estados = new WeakMap();
const API = "/api/admin/lembretes-amanha";
const MINUTO = 60_000;

function criar(tag, classe, texto) {
  const no = document.createElement(tag);
  if (classe) no.className = classe;
  if (texto !== undefined) no.textContent = String(texto);
  return no;
}
function mensagem(item) {
  const primeiroNome = String(item.nome || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  const dia = String(item.data || "").slice(8, 10) + "/" +
    String(item.data || "").slice(5, 7);
  const horario = String(item.horario || "");
  const horaAmigavel = horario.endsWith(":00")
    ? String(Number(horario.slice(0, 2))) + "h" : horario.replace(":", "h");
  const servico = String(item.servico || "seu atendimento").trim().toLocaleLowerCase("pt-BR");
  // Mensagem em primeira pessoa, como se a Isabele estivesse conversando.
  // Sem emojis no link: alguns clientes WhatsApp Web exibem caracteres corrompidos.
  return "Oii, " + primeiroNome + "! Tudo bem?\n\n" +
    "Passando aqui pra te lembrar do nosso horário de amanhã (" + dia +
    "), às " + horaAmigavel + ", pra gente fazer " + servico + ".\n\n" +
    "Te espero, viu? Um beijo!\nIsabele";
}
function autorizado(state) {
  return auth.currentUser?.uid === state.user.uid &&
    document.body.dataset.userRole === "admin";
}
async function requisitar(state, caminho, options = {}) {
  if (!autorizado(state)) throw new Error("Sessão administrativa indisponível.");
  const token = await state.user.getIdToken();
  const resposta = await fetch(API + caminho, {
    cache: "no-store",
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  let dados = {};
  try { dados = await resposta.json(); } catch {}
  if (!resposta.ok) throw new Error(dados.erro || "Não foi possível carregar os lembretes.");
  return dados;
}
function atualizarCard(state) {
  const sinal = state.root.querySelector("[data-ig-lembretes-sinal]");
  const nota = state.root.querySelector("[data-ig-lembretes-resumo]");
  if (!sinal || !nota) return;
  sinal.classList.remove("ig-lembretes-sinal--alerta", "ig-lembretes-sinal--ok");
  if (state.error) {
    sinal.textContent = "Indisponível";
    nota.textContent = "Não foi possível consultar. Toque para tentar novamente.";
  } else if (!state.data) {
    sinal.textContent = "Verificando...";
    nota.textContent = "Consultando os atendimentos de amanhã.";
  } else {
    const { total, pendentes, semTelefone } = state.data.resumo;
    sinal.textContent = pendentes
      ? pendentes + (pendentes === 1 ? " pendente" : " pendentes")
      : semTelefone ? "Atenção" : "Tudo em dia";
    if (pendentes || semTelefone) sinal.classList.add("ig-lembretes-sinal--alerta");
    else sinal.classList.add("ig-lembretes-sinal--ok");
    nota.textContent = !total ? "Nenhum agendamento para amanhã."
      : pendentes ? "Abra a lista para preparar os lembretes."
      : semTelefone ? semTelefone + " atendimento(s) sem telefone válido."
      : "Todos os lembretes possíveis estão marcados como enviados.";
  }
}

function montarCard(item, state) {
  const card = criar("article", "ig-lembrete-cliente");
  const cabecalho = criar("div", "ig-lembrete-cabecalho");
  const informacoes = criar("div", "ig-lembrete-informacoes");
  informacoes.append(
    criar("h4", "ig-lembrete-nome", item.nome),
    criar("p", "ig-lembrete-meta", item.horario + " · " + item.servico),
  );
  const situacao = criar("span", "ig-lembrete-etiqueta", item.marcadoEnviado
    ? "Marcado enviado" : item.possuiTelefone ? "Pendente" : "Sem telefone");
  situacao.classList.add(item.marcadoEnviado
    ? "ig-lembrete-etiqueta--ok" : item.possuiTelefone
      ? "ig-lembrete-etiqueta--pendente" : "ig-lembrete-etiqueta--sem");
  cabecalho.append(informacoes, situacao);
  const acoes = criar("div", "ig-lembrete-acoes");
  const retorno = criar("p", "ig-lembrete-retorno");
  retorno.setAttribute("role", "status");

  if (item.possuiTelefone) {
    const endereco = linkWhatsApp(item.telefone, mensagem(item));
    if (endereco) {
      const link = criar("a", "ig-botao ig-botao--primario ig-lembrete-enviar", "Abrir WhatsApp");
      link.href = endereco;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "Abrir mensagem de lembrete para " + item.nome);
      acoes.append(link);
    }
    const botao = criar("button", "ig-botao ig-botao--secundario",
      item.marcadoEnviado ? "Desfazer marcação" : "Já enviei · Marcar enviado");
    botao.type = "button";
    botao.addEventListener("click", async () => {
      if (!autorizado(state)) return;
      const marcar = !item.marcadoEnviado;
      if (marcar && !window.confirm(
        "Você já enviou a mensagem pelo WhatsApp? " +
        "Marcar não confirma entrega nem leitura."
      )) return;
      botao.disabled = true;
      retorno.textContent = "Salvando confirmação...";
      try {
        await requisitar(state, "/marcacao", {
          method: marcar ? "POST" : "DELETE",
          body: JSON.stringify({
            agendamentoId: item.agendamentoId, assinatura: item.assinatura,
          }),
        });
        await atualizar(state, true);
      } catch (erro) {
        retorno.textContent = erro.message;
        botao.disabled = false;
      }
    });
    acoes.append(botao);
  } else {
    retorno.textContent = "Cadastre um telefone válido na Gestão de Clientes para preparar o lembrete.";
  }
  card.append(cabecalho, acoes, retorno);
  return card;
}
function renderizarModal(state) {
  const lista = state.dialog.querySelector("[data-ig-lembretes-lista]");
  const info = state.dialog.querySelector("[data-ig-lembretes-status]");
  if (!lista || !info) return;
  lista.replaceChildren();
  if (state.error) {
    info.textContent = state.error;
    const tentar = criar("button", "ig-botao ig-botao--secundario", "Tentar novamente");
    tentar.type = "button";
    tentar.addEventListener("click", () => { void atualizar(state, true); });
    lista.append(tentar);
    return;
  }
  if (!state.data) {
    info.textContent = "Carregando os lembretes de amanhã...";
    return;
  }
  const { itens, resumo, data } = state.data;
  const dia = String(data).slice(8, 10) + "/" + String(data).slice(5, 7);
  info.textContent = dia + " · " + resumo.pendentes +
    (resumo.pendentes === 1 ? " lembrete pendente" : " lembretes pendentes");
  if (!itens.length) {
    lista.append(criar("p", "ig-vazio", "Não existem atendimentos ativos para amanhã."));
    return;
  }
  for (const item of itens) lista.append(montarCard(item, state));
}
async function atualizar(state, forcar = false) {
  if (!autorizado(state)) return;
  if (state.promise) return state.promise;
  if (!forcar && state.data && Date.now() - state.ultimoCarregamento < MINUTO) {
    if (state.dialog.open) renderizarModal(state);
    return;
  }
  const trabalho = (async () => {
    try {
      const dados = await requisitar(state, "");
      if (!autorizado(state)) return;
      state.data = dados;
      state.error = "";
      state.ultimoCarregamento = Date.now();
    } catch (erro) {
      state.error = erro.message;
    } finally {
      if (autorizado(state)) {
        atualizarCard(state);
        if (state.dialog.open) renderizarModal(state);
      }
    }
  })();
  state.promise = trabalho;
  try { await trabalho; } finally { state.promise = null; }
}

export function iniciarLembretesAmanha({ root, user }) {
  if (!root || !user?.uid) return;
  let state = estados.get(root);
  if (state) {
    state.user = user;
    void atualizar(state, true);
    return;
  }
  const dialog = document.getElementById("ig-lembretes-dialog");
  const abrir = root.querySelector("[data-ig-lembretes-abrir]");
  if (!dialog || !abrir) return;
  state = {
    root, dialog, abrir, user, data: null, error: "",
    promise: null, ultimoCarregamento: 0,
  };
  estados.set(root, state);
  abrir.addEventListener("click", () => {
    if (!autorizado(state)) return;
    if (!dialog.open) dialog.showModal();
    renderizarModal(state);
    void atualizar(state, true);
  });
  dialog.querySelector("[data-ig-lembretes-fechar]")?.addEventListener("click", () => {
    dialog.close();
  });
  dialog.addEventListener("close", () => abrir.focus());
  window.addEventListener("focus", () => {
    if (dialog.open && autorizado(state)) void atualizar(state, true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && autorizado(state) &&
      Date.now() - state.ultimoCarregamento > MINUTO) void atualizar(state, true);
  });
  atualizarCard(state);
  void atualizar(state, true);
}
