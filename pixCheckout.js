import { auth } from "./firebase-config.js";

// Checkout PIX de testes - Isabele Mariana Nails.
// Intercepta somente um NOVO agendamento de cliente.
// Os fluxos de reagendamento e administrativos permanecem como estao.
const params = new URLSearchParams(location.search);
const novoAgendamentoCliente =
  !params.has("reagendar") && params.get("origem") !== "admin";

let modal;
let status;
let caixaPix;
let caixaCotacao;
let btnProsseguirPix;
let btnRepetir;
let btnCopiar;
let reservaAtual = null;
let cotacaoAtual = null;
let codigoPix = "";
let executando = false;
let conferindo = false;
let polling = null;
let concluido = false;
const STORAGE_RESERVA_PIX = "isabelePixReserva";
const STORAGE_CHAVE_ISENTO = "isabeleAgendamentoSemPixChave";

function obterChaveIdempotenciaIsento(usuario, dados) {
  const assinatura = [usuario.uid, dados.servicoId, dados.data, dados.horario].join("|");
  try {
    const salva = JSON.parse(sessionStorage.getItem(STORAGE_CHAVE_ISENTO) || "null");
    if (salva?.assinatura === assinatura && typeof salva.chave === "string") return salva.chave;
    const chave = crypto.randomUUID();
    sessionStorage.setItem(STORAGE_CHAVE_ISENTO, JSON.stringify({ assinatura, chave }));
    return chave;
  } catch {
    return crypto.randomUUID();
  }
}

function salvarReservaPix() {
  if (!reservaAtual) return;
  try {
    sessionStorage.setItem(STORAGE_RESERVA_PIX, JSON.stringify(reservaAtual));
  } catch (erro) {
    console.warn(
      "[PIX] Não foi possível guardar a reserva nesta sessão:",
      erro.message,
    );
  }
}

function restaurarReservaPix() {
  if (reservaAtual) return;
  try {
    const salva = JSON.parse(
      sessionStorage.getItem(STORAGE_RESERVA_PIX) || "null",
    );
    if (
      salva &&
      typeof salva.reservaId === "string" &&
      typeof salva.clienteUid === "string" &&
      salva.clienteUid === auth.currentUser?.uid
    ) {
      reservaAtual = salva;
    }
  } catch {
    sessionStorage.removeItem(STORAGE_RESERVA_PIX);
  }
}

function moeda(centavos) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(centavos) / 100);
}

function configurarModal() {
  if (modal || !novoAgendamentoCliente) return;
  modal = document.createElement("dialog");
  modal.id = "isabele-pix-dialog";
  modal.className = "im-pix-dialog";
  modal.setAttribute("aria-labelledby", "im-pix-titulo");
  modal.innerHTML = `
    <div class="im-pix-topo">
      <div>
        <span class="im-pix-eyebrow">ISABELE MARIANA NAILS</span>
        <h2 id="im-pix-titulo">Pagamento do sinal</h2>
      </div>
      <button type="button" class="im-pix-fechar" aria-label="Fechar pagamento">×</button>
    </div>
    <p class="im-pix-status" role="status" aria-live="polite"></p>
    <section class="im-pix-cotacao" hidden aria-label="Confira o valor do sinal">
      <div class="im-pix-cotacao-resumo">
        <span>Resumo do agendamento</span>
        <strong id="im-pix-cotacao-servico"></strong>
        <p id="im-pix-cotacao-data"></p>
      </div>
      <div class="im-pix-cotacao-valores">
        <div><span>Valor do serviço</span><strong id="im-pix-cotacao-total"></strong></div>
        <div><span>Sinal para confirmar</span><strong id="im-pix-cotacao-sinal"></strong></div>
        <div><span>Restante no atendimento</span><strong id="im-pix-cotacao-restante"></strong></div>
      </div>
      <p class="im-pix-cotacao-aviso" id="im-pix-cotacao-aviso"></p>
      <button type="button" class="im-pix-prosseguir">Prosseguir para pagamento PIX</button>
      <button type="button" class="im-pix-voltar">Voltar e revisar horário</button>
    </section>
    <section class="im-pix-conteudo" hidden>
      <div class="im-pix-valores">
        <div><span>Sinal PIX</span><strong id="im-pix-sinal"></strong></div>
        <div><span>Restante no atendimento</span><strong id="im-pix-restante"></strong></div>
      </div>
      <aside class="im-pix-politica" aria-label="Política de cancelamento do sinal PIX">
        <p class="im-pix-politica-resumo">
          <strong>Política de cancelamento</strong>
          Cancelamentos e reagendamentos devem ser solicitados com pelo menos
          <strong>24 horas de antecedência.</strong> Fora desse prazo, o sinal
          poderá ser retido, respeitados os direitos legais.
        </p>
        <details class="im-pix-politica-regras">
          <summary>Regras para o Sinal</summary>
          <div class="im-pix-politica-detalhes">
            <p><strong>Com 24h ou mais:</strong> cancelamento com devolução integral do sinal ou reagendamento com aproveitamento do valor pago, conforme disponibilidade.</p>
            <p><strong>Com menos de 24h:</strong> a profissional poderá autorizar um reagendamento excepcional mantendo o sinal. Cancelamentos poderão resultar em retenção quando legalmente cabível.</p>
            <p><strong>Falta sem aviso:</strong> o sinal poderá ser retido nas condições contratadas e permitidas por lei.</p>
            <p><strong>Direitos da cliente:</strong> permanecem preservados, inclusive o direito de arrependimento quando aplicável.</p>
            <a href="termos.html#sinal-pix" target="_blank" rel="noopener noreferrer">Consultar os Termos de Uso completos</a>
          </div>
        </details>
      </aside>
      <img class="im-pix-qr" alt="QR Code PIX para pagamento do sinal" hidden>
      <p class="im-pix-instrucao">Escaneie o código pelo aplicativo do seu banco ou copie a chave abaixo.</p>
      <label for="im-pix-codigo">PIX Copia e Cola</label>
      <textarea id="im-pix-codigo" readonly rows="3" spellcheck="false"></textarea>
      <button type="button" class="im-pix-copiar">Copiar código PIX</button>
      <p class="im-pix-nota">Ambiente de desenvolvimento com credenciais de teste. Seu horário será confirmado após a identificação do pagamento.</p>
    </section>
    <button type="button" class="im-pix-repetir" hidden>Tentar novamente</button>
  `;
  document.body.appendChild(modal);
  status = modal.querySelector(".im-pix-status");
  caixaPix = modal.querySelector(".im-pix-conteudo");
  caixaCotacao = modal.querySelector(".im-pix-cotacao");
  btnProsseguirPix = modal.querySelector(".im-pix-prosseguir");
  btnRepetir = modal.querySelector(".im-pix-repetir");
  btnCopiar = modal.querySelector(".im-pix-copiar");
  modal
    .querySelector(".im-pix-fechar")
    .addEventListener("click", () => modal.close());
  btnCopiar.addEventListener("click", async () => {
    if (!codigoPix) return;
    try {
      await navigator.clipboard.writeText(codigoPix);
    } catch {
      const campo = modal.querySelector("#im-pix-codigo");
      campo.focus();
      campo.select();
      status.textContent = "Selecione e copie o código PIX exibido.";
      return;
    }
    btnCopiar.textContent = "Código copiado!";
  });
  btnProsseguirPix.addEventListener("click", () => void iniciarCheckout({ prosseguirPagamento: true }));
  modal.querySelector(".im-pix-voltar").addEventListener("click", () => {
    cotacaoAtual = null;
    caixaCotacao.hidden = true;
    modal.close();
  });
  btnRepetir.addEventListener("click", () => void iniciarCheckout());
  modal.addEventListener("cancel", () => {
    // A consulta pode continuar enquanto o modal esta fechado.
  });
}

function mensagem(texto, erro = false) {
  status.textContent = texto;
  status.classList.toggle("im-pix-status--erro", erro);
}

async function chamarApi(caminho, { method = "POST", dados } = {}) {
  const usuario = auth.currentUser;
  if (!usuario) throw new Error("Entre na sua conta para reservar o horário.");
  const token = await usuario.getIdToken();
  const resposta = await fetch(`/api${caminho}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    ...(dados ? { body: JSON.stringify(dados) } : {}),
    cache: "no-store",
  });
  const tipo = resposta.headers.get("content-type") || "";

  if (resposta.status === 502) {
    console.error("[PIX Checkout] HTTP 502", {
      rota: caminho,
      status: resposta.status,
    });

    throw new Error(
      "Tivemos uma instabilidade momentânea. " +
        "Aguarde alguns instantes e tente novamente. " +
        "Se o problema continuar, entre em contato com a Isabele. " +
        "Código de atendimento: P02.",
    );
  }

  if (!tipo.includes("application/json")) {
    throw new Error(
      `A API PIX não respondeu corretamente (HTTP ${resposta.status}).`,
    );
  }
  const corpo = await resposta.json();
  if (!resposta.ok) {
    const erro = new Error(corpo.erro || `Falha HTTP ${resposta.status}`);
    erro.codigo = corpo.codigo;
    throw erro;
  }
  return corpo;
}

const postApi = (caminho, dados) => chamarApi(caminho, { method: "POST", dados });
const getApi = (caminho) => chamarApi(caminho, { method: "GET" });

function selecionarDados() {
  const servicoId = params.get("id");
  const data = document.querySelector(".agendamento-date--active")?.dataset
    .dateIso;
  const horario = document.querySelector(".agendamento-time--active")?.dataset
    .time;
  const nome = document.querySelector("#nomeCliente")?.value.trim();
  if (
    !servicoId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data || "") ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario || "") ||
    !nome
  ) {
    throw new Error(
      "Preencha seu nome e selecione uma data e um horário válidos.",
    );
  }
  return {
    servicoId,
    data,
    horario,
    nome,
    nomeServico:
      document.querySelector("#service-name")?.textContent?.trim() || "Serviço",
  };
}

function apresentarCotacao(cotacao, dados) {
  const total = Number(cotacao.valorTotalCentavos);
  const sinal = Number(cotacao.valorSinalCentavos);
  const restante = Number(cotacao.valorRestanteCentavos);
  const minutos = Number(cotacao.reservaMinutos);

  if (
    !Number.isSafeInteger(total) || total <= 0 ||
    !Number.isSafeInteger(sinal) || sinal <= 0 ||
    !Number.isSafeInteger(restante) || restante < 0 ||
    total !== sinal + restante ||
    !Number.isInteger(minutos) || minutos < 30 || minutos > 60 ||
    cotacao.servicoId !== dados.servicoId
  ) {
    throw new Error("Não foi possível conferir o valor do sinal. Tente novamente.");
  }

  cotacaoAtual = {
    servicoId: dados.servicoId,
    data: dados.data,
    horario: dados.horario,
  };

  const [ano, mes, dia] = dados.data.split("-");
  modal.querySelector("#im-pix-cotacao-servico").textContent =
    cotacao.servico || dados.nomeServico;
  modal.querySelector("#im-pix-cotacao-data").textContent =
    `${dia}/${mes}/${ano} às ${dados.horario}`;
  modal.querySelector("#im-pix-cotacao-total").textContent = moeda(total);
  modal.querySelector("#im-pix-cotacao-sinal").textContent = moeda(sinal);
  modal.querySelector("#im-pix-cotacao-restante").textContent = moeda(restante);
  modal.querySelector("#im-pix-cotacao-aviso").textContent =
    `Nenhum horário foi reservado ainda. Ao prosseguir, a reserva temporária terá um prazo inicial de ${minutos} minutos para o pagamento do sinal. A disponibilidade será verificada novamente.`;

  modal.querySelector("#im-pix-titulo").textContent = "Confira o valor do sinal";
  btnProsseguirPix.disabled = false;
  btnProsseguirPix.textContent = "Prosseguir para pagamento PIX";
  caixaCotacao.hidden = false;
  mensagem("Confira os valores antes de iniciar o pagamento.");
  if (modal.open) btnProsseguirPix.focus();
}

function mostrarPedido(pedido) {
  const pix = pedido.pix || {};
  codigoPix = pix.copiaECola || "";
  if (!codigoPix && !pix.qrCodeBase64) {
    throw new Error(
      "O Mercado Pago não retornou o QR Code PIX. Tente novamente.",
    );
  }
  modal.querySelector("#im-pix-sinal").textContent = moeda(
    reservaAtual.valorSinalCentavos,
  );
  modal.querySelector("#im-pix-restante").textContent = moeda(
    reservaAtual.valorRestanteCentavos,
  );
  const img = modal.querySelector(".im-pix-qr");
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(pix.qrCodeBase64 || "")) {
    img.src = `data:image/png;base64,${pix.qrCodeBase64.replace(/\s/g, "")}`;
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute("src");
  }
  modal.querySelector("#im-pix-codigo").value = codigoPix;
  btnCopiar.disabled = !codigoPix;
  btnCopiar.textContent = "Copiar código PIX";
  btnRepetir.textContent = "Tentar novamente";
  caixaCotacao.hidden = true;
  modal.querySelector("#im-pix-titulo").textContent = "Pagamento do sinal";
  caixaPix.hidden = false;
  mensagem("PIX gerado! Aguardando confirmação do pagamento de teste...");
}

async function emitirAteObterPedido() {
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const pedido = await postApi("/pix/emitir", {
      reservaId: reservaAtual.reservaId,
    });
    if (pedido.status === "processando") {
      mensagem("Mercado Pago está preparando o PIX. Aguarde...");
      await new Promise((resolve) => setTimeout(resolve, 12000));
      continue;
    }
    mostrarPedido(pedido);
    return;
  }
  throw new Error("O PIX ainda está sendo preparado. Use 'Tentar novamente'.");
}

function pararConsulta() {
  if (polling) clearInterval(polling);
  polling = null;
}

function concluirAgendamento() {
  if (concluido) return;
  concluido = true;
  pararConsulta();
  localStorage.removeItem("isabeleAgendamentoSemPix");
  localStorage.removeItem("isabeleAgendamentoSemPixId");
  mensagem("Pagamento identificado! Seu horário foi confirmado.");
  localStorage.setItem("dataAgendamento", reservaAtual.data);
  localStorage.setItem("dataAgendamentoISO", reservaAtual.data);
  localStorage.setItem("horaAgendamento", reservaAtual.horario);
  localStorage.setItem("horarioAgendamento", reservaAtual.horario);
  localStorage.setItem("nomeCliente", reservaAtual.nome);
  localStorage.setItem("nomeUsuario", reservaAtual.nome);
  localStorage.setItem("servicoAgendamento", reservaAtual.nomeServico);
  localStorage.setItem("isabelePixReservaId", reservaAtual.reservaId);
  sessionStorage.removeItem(STORAGE_RESERVA_PIX);
  setTimeout(() => {
    window.location.assign("confirmacao.html");
  }, 1400);
}

async function conferirPagamento() {
  if (conferindo || !reservaAtual || concluido) return;
  conferindo = true;
  try {
    const retorno = await postApi("/pix/status", {
      reservaId: reservaAtual.reservaId,
    });
    if (retorno.agendamentoConfirmado === true) {
      concluirAgendamento();
    } else if (retorno.pagamentoCreditado === true) {
      mensagem("PIX creditado! Finalizando a confirmação do horário...");
    } else if (
      ["revisao_financeira", "pago_requer_analise"].includes(retorno.situacao)
    ) {
      pararConsulta();
      btnRepetir.textContent = "Consultar novamente";
      btnRepetir.hidden = false;
      mensagem(
        "Não foi possível concluir a confirmação automaticamente. Não faça outro pagamento; consulte novamente ou fale com o salão.",
        true,
      );
    } else if (
      ["expirada", "cancelada", "estornada", "falha"].includes(retorno.situacao)
    ) {
      pararConsulta();
      reservaAtual = null;
      codigoPix = "";
      sessionStorage.removeItem(STORAGE_RESERVA_PIX);
      btnRepetir.textContent = "Tentar nova reserva";
      btnRepetir.hidden = false;
      mensagem(
        "Esta cobrança não está mais disponível. Inicie uma nova reserva.",
        true,
      );
    } else {
      mensagem("Aguardando a identificação do pagamento PIX...");
    }
  } catch (erro) {
    // Falhas temporarias nao interrompem a verificacao.
    console.warn("[PIX] Consulta do pagamento:", erro.message);
    mensagem("Conexão instável. Tentando consultar novamente...");
  } finally {
    conferindo = false;
  }
}

async function iniciarCheckout({ prosseguirPagamento = false } = {}) {
  configurarModal();
  if (executando) return;
  if (!modal.open) modal.showModal();
  if (concluido) return;
  restaurarReservaPix();
  // O cliente só pode prosseguir depois de conferir uma cotação desta seleção.
  if (prosseguirPagamento && (
    !cotacaoAtual || caixaCotacao.hidden || reservaAtual
  )) return;
  if (reservaAtual && codigoPix) {
    mensagem("Aguardando confirmação do pagamento de teste...");
    if (!polling) {
      polling = setInterval(() => void conferirPagamento(), 5000);
      void conferirPagamento();
    }
    return;
  }
  executando = true;
  btnRepetir.hidden = true;
  caixaPix.hidden = true;
  if (prosseguirPagamento) {
    btnProsseguirPix.disabled = true;
    btnProsseguirPix.textContent = "Preparando pagamento...";
  } else {
    caixaCotacao.hidden = true;
    cotacaoAtual = null;
  }
  try {
    mensagem("Verificando a autorização para o agendamento...");
    const dados = selecionarDados();

    // O backend revalida a permissão ao confirmar; esta consulta só escolhe
    // qual caminho apresentar. O fluxo PIX continua sendo o padrão.
    const permissao = await getApi("/agendamentos/isencao");
    if (permissao.isentaSinalPix === true) {
      try {
        const agendamento = await postApi("/agendamentos/sem-pix", {
          servicoId: dados.servicoId,
          data: dados.data,
          horario: dados.horario,
          observacoes: document.querySelector("#agendamento-notes")?.value || "",
          chaveIdempotencia: obterChaveIdempotenciaIsento(auth.currentUser, dados),
        });
        localStorage.setItem("dataAgendamento", dados.data);
        localStorage.setItem("dataAgendamentoISO", dados.data);
        localStorage.setItem("horaAgendamento", dados.horario);
        localStorage.setItem("horarioAgendamento", dados.horario);
        localStorage.setItem("nomeCliente", dados.nome);
        localStorage.setItem("nomeUsuario", dados.nome);
        localStorage.setItem("servicoAgendamento", dados.nomeServico);
        localStorage.setItem("observacoesAgendamento", document.querySelector("#agendamento-notes")?.value?.trim() || "");
        localStorage.setItem("isabeleAgendamentoSemPix", "true");
        localStorage.setItem("isabeleAgendamentoSemPixId", agendamento.agendamentoId);
        sessionStorage.removeItem(STORAGE_CHAVE_ISENTO);

        // A sincronizacao Calendar e executada de forma duravel pelo backend.
        // Evita dupla criacao de eventos por requisicao do navegador.

        modal.close();
        window.location.assign("confirmacao.html");
        return;
      } catch (erro) {
        if (erro.codigo !== "ISENCAO_INATIVA") throw erro;
        // Uma revogação ocorrida entre a consulta e a gravação volta ao PIX.
      }
    }

    if (!reservaAtual && !prosseguirPagamento) {
      mensagem("Consultando o valor do sinal...");
      // Cotação de leitura: não cria PIX e não reserva horários.
      const cotacao = await postApi("/pix/cotacao", {
        servicoId: dados.servicoId,
      });
      apresentarCotacao(cotacao, dados);
      return;
    }

    if (!reservaAtual && (
      !cotacaoAtual ||
      cotacaoAtual.servicoId !== dados.servicoId ||
      cotacaoAtual.data !== dados.data ||
      cotacaoAtual.horario !== dados.horario
    )) {
      throw new Error("O horário selecionado mudou. Confira o valor do sinal novamente.");
    }

    mensagem("Preparando a reserva e gerando o PIX...");
    if (!reservaAtual) {
      const criada = await postApi("/pix/reservar", {
        servicoId: dados.servicoId,
        nomeCliente: dados.nome,
        data: dados.data,
        horario: dados.horario,
      });
      reservaAtual = { ...dados, ...criada };
      reservaAtual.clienteUid = auth.currentUser.uid;
      salvarReservaPix();
    }
    await emitirAteObterPedido();
    cotacaoAtual = null;
    pararConsulta();
    polling = setInterval(() => void conferirPagamento(), 5000);
    void conferirPagamento();
  } catch (erro) {
    console.error("[PIX Checkout]", erro);
    mensagem(erro.message || "Não foi possível gerar o PIX.", true);
    btnRepetir.hidden = false;
  } finally {
    executando = false;
    if (btnProsseguirPix) {
      btnProsseguirPix.disabled = false;
      btnProsseguirPix.textContent = "Prosseguir para pagamento PIX";
    }
  }
}

// Intercepta novos agendamentos de clientes. Reagendamentos, inclusive os
// iniciados pela administradora, seguem pela validação segura da API.
if (novoAgendamentoCliente) {
  document.addEventListener(
    "click",
    (evento) => {
      const alvo = evento.target;
      if (!(alvo instanceof Element)) return;
      const botao = alvo.closest(".agendamento-button");
      if (!botao || botao.disabled) return;
      evento.preventDefault();
      evento.stopImmediatePropagation();
      void iniciarCheckout();
    },
    true,
  );
}
