/**
 * Análise Web da Isabele — Fase 2C: auditor local da dataLayer.
 * Uso: copie este conteúdo em Sources > Snippets no navegador e execute
 * com a tela de agendamento aberta e uma conta de cliente de QA.
 *
 * Somente leitura: não gera eventos, não envia dados e não altera reservas.
 * NÃO imprime valores de payloads, nomes ou identificadores.
 */
(() => {
  "use strict";
  const ESPERADOS = Object.freeze([
    "booking_flow_started",
    "booking_date_selected",
    "booking_suggestions_displayed",
    "booking_suggestion_selected",
    "booking_all_times_opened",
    "booking_time_selected",
    "booking_submit_clicked",
    "booking_quote_viewed",
    "booking_pix_qr_shown",
    "booking_pix_confirmed_ui",
    "booking_exempt_confirmed_ui",
    "booking_reschedule_completed_ui",
  ]);
  const NOMES = new Set(ESPERADOS);
  const CAMPOS = new Set([
    "flow_type", "actor_role", "service_category", "analytics_schema_version",
    "selection_source", "time_bucket", "payment_path",
    "page_location", "page_referrer",
  ]);
  const CATEGORIAS = new Set(["manicure", "pedicure", "unhas-em-gel", "unknown"]);
  const PAGAMENTO = new Map([
    ["booking_quote_viewed", "pix"],
    ["booking_pix_qr_shown", "pix"],
    ["booking_pix_confirmed_ui", "pix"],
    ["booking_exempt_confirmed_ui", "exempt"],
  ]);

  function auditar(camadas = window.dataLayer || []) {
    const contagens = Object.fromEntries(ESPERADOS.map((nome) => [nome, 0]));
    const alertas = [];
    const adicionar = (indice, evento, codigo) => {
      // Não registrar valores sensíveis, apenas índice, nome e tipo de problema.
      alertas.push({ posicao: indice, evento, codigo });
    };
    let encontradoConfig = false;

    for (const [indice, entrada] of Array.from(camadas).entries()) {
      if (!entrada || typeof entrada.length !== "number") continue;

      if (entrada[0] === "config" && entrada[1] === "G-ZFCQC4FFJS") {
        encontradoConfig = true;
        const config = entrada[2] || {};
        if (config.send_page_view !== false &&
            /\/agendamento\.html$/i.test(window.location.pathname)) {
          adicionar(indice, "gtag_config", "page_view_nao_desabilitada");
        }
      }

      if (entrada[0] !== "event") continue;
      const nome = entrada[1];
      if (typeof nome !== "string" || !nome.startsWith("booking_")) continue;
      if (!NOMES.has(nome)) {
        adicionar(indice, "booking_desconhecido", "evento_fora_do_contrato");
        continue;
      }

      contagens[nome]++;
      const parametros = entrada[2];
      if (!parametros || typeof parametros !== "object" || Array.isArray(parametros)) {
        adicionar(indice, nome, "parametros_ausentes");
        continue;
      }

      for (const campo of Object.keys(parametros)) {
        if (!CAMPOS.has(campo)) adicionar(indice, nome, "parametro_nao_previsto");
      }
      if (parametros.actor_role !== "client") adicionar(indice, nome, "papel_diferente_de_cliente");
      if (!["new", "reschedule"].includes(parametros.flow_type)) {
        adicionar(indice, nome, "tipo_de_fluxo_invalido");
      }
      if (!CATEGORIAS.has(parametros.service_category)) {
        adicionar(indice, nome, "categoria_fora_da_lista");
      }
      if (parametros.analytics_schema_version !== 1) {
        adicionar(indice, nome, "versao_invalida");
      }
      const pagamento = PAGAMENTO.get(nome);
      if (pagamento && parametros.payment_path !== pagamento) {
        adicionar(indice, nome, "caminho_pagamento_invalido");
      }
      if (!pagamento && Object.hasOwn(parametros, "payment_path")) {
        adicionar(indice, nome, "pagamento_em_evento_inadequado");
      }
      if (nome === "booking_time_selected") {
        if (!["suggestion", "full_list"].includes(parametros.selection_source)) {
          adicionar(indice, nome, "origem_horario_invalida");
        }
        if (!["morning", "afternoon", "evening"].includes(parametros.time_bucket)) {
          adicionar(indice, nome, "periodo_horario_invalido");
        }
      } else if (Object.hasOwn(parametros, "selection_source") ||
                 Object.hasOwn(parametros, "time_bucket")) {
        adicionar(indice, nome, "dimensao_de_horario_em_evento_inadequado");
      }
      if (nome === "booking_reschedule_completed_ui" &&
          parametros.flow_type !== "reschedule") {
        adicionar(indice, nome, "reagendamento_como_nova_reserva");
      }
      if (pagamento && parametros.flow_type !== "new") {
        adicionar(indice, nome, "checkout_novo_como_reagendamento");
      }

      for (const campo of ["page_location", "page_referrer"]) {
        if (!Object.hasOwn(parametros, campo)) continue;
        try {
          const url = new URL(String(parametros[campo]));
          if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) {
            adicionar(indice, nome, "url_com_parametros_ou_fragmento");
          }
        } catch {
          if (parametros[campo] !== "") adicionar(indice, nome, "url_invalida");
        }
      }
      // Padrões óbvios de dados pessoais vazados em qualquer valor STRING.
      // NÃO exibe o valor suspeito no relatório, nem copia o payload.
      for (const valor of Object.values(parametros)) {
        if (typeof valor !== "string") continue;
        if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(valor) ||
            /(?:firebase_uid|agendamentoId|pixCobrancaId|reagendar=|token=|clienteUid)/i.test(valor)) {
          adicionar(indice, nome, "possivel_dado_pessoal");
        }
      }
    }

    if (!encontradoConfig) adicionar(-1, "gtag_config", "config_nao_observada");
    if (contagens.booking_flow_started > 1) {
      adicionar(-1, "booking_flow_started", "multiplo_inicio_na_mesma_pagina");
    }
    if (contagens.booking_suggestions_displayed > 1) {
      adicionar(-1, "booking_suggestions_displayed", "multiplas_exibicoes_na_mesma_pagina");
    }
    if (contagens.booking_pix_confirmed_ui > 1) {
      adicionar(-1, "booking_pix_confirmed_ui", "sucesso_pix_repetido_na_mesma_pagina");
    }

    return {
      eventos: ESPERADOS.map((evento) => ({ evento, ocorrencias: contagens[evento] })),
      alertas,
      nomesNaoObservados: ESPERADOS.filter((nome) => contagens[nome] === 0),
      avisos: [
        "Ausência de um evento não é falha sem executar aquela etapa.",
        "dataLayer local não confirma recebimento no GA4. Use DebugView/Tag Assistant.",
        "Não simule pagamentos ou cancelamentos no ambiente de produção.",
      ],
    };
  }

  window.__isabeleGA4Auditoria = auditar;
  const resultado = auditar();
  console.info("[Análise Web 2C] Contagem local de eventos GA4 (sem dados pessoais):");
  console.table(resultado.eventos);
  console.info("[Análise Web 2C] Alertas estruturais:", resultado.alertas.length);
  if (resultado.alertas.length) console.table(resultado.alertas);
  console.info("[Análise Web 2C] Eventos não observados nesta página:", resultado.nomesNaoObservados.join(", "));
  console.info("[Análise Web 2C] Importante:", resultado.avisos.join(" "));
})();
