/** Assistente Isabele: somente leitura após autenticação administrativa. */
import { auth, db } from "./firebase-config.js";
import { getDocs, collection } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";
import { obterHojeSaoPaulo, obterJanelasAtendimento } from "./infra/backend/src/agendamentoRegras.mjs?v=2.1.0";
import { montarVisaoGestao, formatarDuracao, formatarDataBR, mensagemRetorno, linkWhatsApp } from "./assistenteGestaoCore.mjs";

const $ = (root, seletor) => root.querySelector(seletor);
const set = (root, seletor, valor) => { const el = $(root, seletor); if (el) el.textContent = String(valor); };
function el(tag, classe, texto) {
  const node = document.createElement(tag);
  if (classe) node.className = classe;
  if (texto !== undefined) node.textContent = String(texto);
  return node;
}
function horaSP(data = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(data);
  const obj = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return obj.hour + ":" + obj.minute;
}
async function consultarPix(user, data, expediente) {
  if (!expediente.length) return [];
  try {
    const url = new URL("/api/pix/disponibilidade", window.location.origin);
    url.searchParams.set("data", data);
    const resposta = await fetch(url, { cache: "no-store",
      headers: { Authorization: "Bearer " + await user.getIdToken() } });
    if (!resposta.ok) throw new Error("Disponibilidade indisponível");
    const conteudo = await resposta.json();
    if (!Array.isArray(conteudo?.intervalos)) throw new Error("Resposta inválida da disponibilidade");
    return conteudo.intervalos;
  } catch (error) {
    console.warn("[Assistente Gestão] Tempo livre não confirmado:", error.message);
    return null; // Não estimar disponibilidade se o PIX/bloqueios não puderem ser consultados.
  }
}
function destino(item, contexto) {
  if (item.link === "#ig-radar" || item.link === "#ig-semana") {
    return contexto === "home" ? "./admin-assistente.html" + item.link : item.link;
  }
  return item.link === "./admin-agendamentos.html" ? item.link : "./admin-assistente.html";
}
function recomendacoes(root, itens, contexto) {
  let indice = 0;
  const proxima = $(root, "[data-ig-proxima]");
  function exibir() {
    const item = itens[indice];
    set(root, "[data-ig-recomendacao-titulo]", item.titulo);
    set(root, "[data-ig-recomendacao-texto]", item.descricao);
    const link = $(root, "[data-ig-recomendacao-link]");
    if (link) { link.href = destino(item, contexto); link.textContent = item.acao; }
  }
  if (proxima) {
    proxima.hidden = itens.length < 2;
    proxima.onclick = () => { indice = (indice + 1) % itens.length; exibir(); };
  }
  exibir();
}
function copiarMensagem(texto, status) {
  const botao = el("button", "ig-botao ig-botao--secundario", "Copiar mensagem");
  botao.type = "button";
  botao.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard indisponível");
      await navigator.clipboard.writeText(texto);
      status.textContent = "Mensagem copiada; revise antes de enviar.";
    } catch { status.textContent = "Não foi possível copiar. Selecione o texto da mensagem."; }
  });
  return botao;
}
function radarClientes(root, radar) {
  const lista = $(root, "[data-ig-radar-lista]");
  if (!lista) return;
  lista.replaceChildren();
  set(root, "[data-ig-radar-contagem]", radar.length + " sugestão(ões) de retorno");
  if (!radar.length) {
    lista.append(el("p", "ig-vazio", "Nenhuma oportunidade de retorno foi identificada nas condições analisadas."));
    return;
  }
  for (const cliente of radar.slice(0, 6)) {
    const card = el("article", "ig-cliente");
    const prazo = cliente.diasParaRetorno < 0 ? "Sugestão há " + Math.abs(cliente.diasParaRetorno) + " dia(s)"
      : cliente.diasParaRetorno === 0 ? "Retorno sugerido para hoje"
        : "Retorno sugerido em " + cliente.diasParaRetorno + " dia(s)";
    const mensagem = mensagemRetorno(cliente);
    const status = el("p", "ig-status-acao");
    status.setAttribute("role", "status");
    const acoes = el("div", "ig-acoes");
    const endereco = linkWhatsApp(cliente.telefone, mensagem);
    if (endereco) {
      const link = el("a", "ig-botao ig-botao--primario", "Abrir WhatsApp");
      link.href = endereco;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "Revisar mensagem de " + cliente.nome + " no WhatsApp");
      acoes.append(link);
    } else {
      acoes.append(el("span", "ig-sem-telefone", "Sem telefone válido cadastrado"));
    }
    acoes.append(copiarMensagem(mensagem, status));
    card.append(
      el("h4", "ig-cliente-nome", cliente.nome),
      el("p", "ig-cliente-meta", prazo + " · Última visita: " + formatarDataBR(cliente.ultimaVisita)),
      el("p", "ig-cliente-meta", cliente.criterio + "."),
      el("p", "ig-mensagem", mensagem),
      acoes, status,
    );
    lista.append(card);
  }
  if (radar.length > 6) lista.append(el("p", "ig-nota", "Mostrando as 6 oportunidades mais relevantes. Confira os demais históricos na gestão de clientes."));
}
function semanaDados(root, semana) {
  set(root, "[data-ig-semana-atual]", semana.atual.concluidos);
  set(root, "[data-ig-semana-anterior]", semana.anterior.concluidos);
  set(root, "[data-ig-semana-cancelamentos]", semana.atual.cancelados);
  set(root, "[data-ig-semana-servico]", semana.atual.maisFrequente || "Nenhum neste período");
  const comparativo = semana.atual.concluidos > semana.anterior.concluidos ? "aumentou"
    : semana.atual.concluidos < semana.anterior.concluidos ? "diminuiu" : "permaneceu estável";
  set(root, "[data-ig-semana-leitura]", "O número de atendimentos concluídos " + comparativo
    + " em relação aos sete dias anteriores.");
  const valor = semana.atual.receitaEstimada;
  set(root, "[data-ig-semana-valor]", valor === null
    ? "Valor não disponível: alguns atendimentos não possuem preço registrado."
    : "Valor cadastrado dos serviços concluídos: "
      + new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor)
      + ". Não equivale necessariamente a valores recebidos.");
}
function exibir(root, visao, contexto) {
  set(root, "[data-ig-atendimentos]", visao.resumo.atendimentos);
  set(root, "[data-ig-livre]", visao.resumo.tempoLivreRestante === null
    ? "—" : formatarDuracao(visao.resumo.tempoLivreRestante));
  set(root, "[data-ig-livre-nota]", visao.resumo.tempoLivreRestante === null
    ? "Não foi possível confirmar as reservas PIX e bloqueios. Confira a agenda."
    : "Tempo restante livre no expediente, considerando reservas e bloqueios.");
  set(root, "[data-ig-proximo]", visao.resumo.proximo
    ? "Próximo atendimento às " + visao.resumo.proximo.horario
    : "Nenhum próximo atendimento registrado para hoje.");
  recomendacoes(root, visao.recomendacoes, contexto);
  if (contexto === "detalhe") {
    radarClientes(root, visao.radar);
    semanaDados(root, visao.semana);
  }
  set(root, "[data-ig-atualizado]", "Consulta às " + horaSP() + ". Nenhuma alteração feita na agenda.");
  $(root, "[data-ig-estado]").hidden = true;
  $(root, "[data-ig-dados]").hidden = false;
}
/**
 * O card da principal inicia recolhido. Indicadores e recomendação ficam fora
 * do painel recolhível; apenas o conteúdo complementar é expandido.
 */
function prepararExpansaoHome(root) {
  const botao = $(root, "[data-ig-toggle]");
  const painel = $(root, "[data-ig-expansivel]");
  if (!botao || !painel) return;
  const label = $(botao, "[data-ig-toggle-texto]");
  function aplicar(aberto) {
    painel.hidden = !aberto;
    botao.setAttribute("aria-expanded", String(aberto));
    if (label) label.textContent = aberto ? "Recolher" : "Expandir";
    root.classList.toggle("ig-aberto", aberto);
  }
  aplicar(false);
  botao.onclick = () => aplicar(botao.getAttribute("aria-expanded") !== "true");
}

export async function iniciarAssistenteGestao({ user, contexto = "home" }) {
  const root = document.querySelector('[data-ig-contexto="' + contexto + '"]');
  if (!root || !user?.uid) return;
  const autorizado = () => auth.currentUser?.uid === user.uid &&
    (contexto === "home" ? document.body.dataset.userRole === "admin"
      : document.body.dataset.accessState === "allowed");
  if (!autorizado()) return;
  if (contexto === "home") {
    prepararExpansaoHome(root);
    // A lista de amanha carrega em paralelo e nao atrasa o resumo do dia.
    void import("./assistenteLembretesWhatsappUI.js?v=3")
      .then(({ iniciarLembretesAmanha }) => {
        if (autorizado()) iniciarLembretesAmanha({ root, user });
      })
      .catch((erro) => {
        console.warn("[Assistente Gestão] Lembretes WhatsApp indisponíveis:", erro.message);
      });
  }
  const estado = $(root, "[data-ig-estado]"), dados = $(root, "[data-ig-dados]");
  estado.hidden = false;
  estado.textContent = "Preparando recomendações com seus dados...";
  dados.hidden = true;
  const atualizar = $(root, "[data-ig-atualizar]");
  if (atualizar) {
    atualizar.onclick = () => { void iniciarAssistenteGestao({ user, contexto }); };
    atualizar.disabled = true;
  }
  try {
    const agora = new Date(), hoje = obterHojeSaoPaulo(agora);
    const janelas = obterJanelasAtendimento(hoje);
    const [agendamentos, clientes, intervalosPix] = await Promise.all([
      getDocs(collection(db, "agendamentos")), getDocs(collection(db, "clientes")),
      consultarPix(user, hoje, janelas),
    ]);
    if (!autorizado()) return;
    const visao = montarVisaoGestao({
      hoje, horarioAtual: horaSP(agora), janelas, intervalosPix,
      agendamentos: agendamentos.docs.map((d) => ({ id: d.id, ...d.data() })),
      clientes: clientes.docs.map((d) => ({ id: d.id, ...d.data() })),
    });
    exibir(root, visao, contexto);
  } catch (error) {
    if (!autorizado()) return;
    console.error("[Assistente Gestão] Erro de leitura:", error);
    dados.hidden = true;
    estado.hidden = false;
    estado.textContent = "Não foi possível conferir os dados da gestão. Tente atualizar.";
  } finally { if (atualizar) atualizar.disabled = false; }
}
