import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  encerrarCobrancaPixSemPagamento,
  classificarReservaAposCredito,
  registrarCreditoPix,
} from "../src/pixConciliacao.js";
import {
  encontrarConflitoAgendamentoPix,
  montarAgendamentoPix,
  obterDuracaoAgendamentoPix,
} from "../src/pixDocumentoAgendamento.js";
import { efetivarAgendamentoPix } from "../src/pixEfetivacao.js";
import {
  gerarIdAgendamentoPix,
  validarReservaVigentePix,
} from "../src/pixRegrasConfirmacao.js";
import { consultarStatusPagamentoPix } from "../src/pixConsultaPagamento.js";
import { validarRetornoPagamentoPix } from "../src/pixValidacaoPagamento.js";
import { processarProximaSincronizacaoCalendar, montarPayloadCalendar, enviarEventoCalendar } from "../src/pixCalendarWorker.js";
import { ambienteMercadoPagoAtual, consultarPedidoPix, consultarPedidoPixComLock, criarPedidoPix, mercadoPagoHabilitado, montarPedidoPix } from "../src/pixMercadoPago.js";
import { identificarNotificacoesAgendamento } from "../src/agendaNotificacoes.js";
import { processarOrderNotificada } from "../src/pixWebhookWorker.js";
import { configuracaoPixPolling, processarCicloPixPolling, reservarCobrancasElegiveis, segundosProximaConsulta } from "../src/pixPollingWorker.js";
import { processarProximaNotificacaoPix } from "../src/pixWebhookFila.js";
import { atenderWebhookPix, validarAssinaturaWebhookPix } from "../src/pixWebhook.js";
import { pagamentoPixConfirmadoManualmente } from "../src/pixRegrasConfirmacao.js";
import { atenderConfirmacaoAgendamentoPix } from "../src/pixAgendamentoConfirmacao.js";
import { calcularSinalServico, criarCamposSinalServico, obterEntradaSinalServico } from "../src/pixSinalServico.js";

const cobrancaBase = {
  id: "6d8f562d-5e85-4bc8-9705-932158e7c2a9",
  mp_order_id: "order-test-1",
  referencia_externa: "isabele_pix_6d8f562d5e854bc89705932158e7c2a9",
  valor_total_centavos: 3000,
  valor_sinal_centavos: 2000,
  valor_restante_centavos: 1000,
  cliente_uid: "cliente-1",
  estado: "paga",
  pago_em: new Date().toISOString(),
  reserva_dados: { nomeServico: "Manicure Simples", nomeCliente: "Cliente Teste" },
};

const aprovado = {
  pedidoId: cobrancaBase.mp_order_id,
  referenciaExterna: cobrancaBase.referencia_externa,
  valorPedido: "20.00",
  valorPagamento: "20.00",
  statusPedido: "processed",
  detalhePedido: "accredited",
  statusPagamento: "processed",
  detalhePagamento: "accredited",
};

function criarEstadoPg({ reservaEstado = "reservada", venceEm = Date.now() + 60000 } = {}) {
  return {
    charge: {
      ...cobrancaBase,
      estado: "paga",
      pago_em: new Date().toISOString(),
    },
    reservation: {
      id: "b52cf512-e0c4-4d71-b3ca-0ef72b0b42bc",
      cobranca_id: cobrancaBase.id,
      cliente_uid: cobrancaBase.cliente_uid,
      servico_id: "manicure",
      estado: reservaEstado,
      vence_em: new Date(venceEm).toISOString(),
      inicio_minuto: 600,
      fim_minuto: 660,
      data_iso: "2099-01-01",
      agendamento_id: null,
    },
  };
}

function criarPoolEfetivacao({ falharUmaVezEmReserva = false, estado } = {}) {
  const dados = estado || criarEstadoPg();
  let fila = Promise.resolve();
  let falhar = falharUmaVezEmReserva;
  const eventos = new Set();
  const calendarOutbox = new Map();
  const ordemOperacoes = [];

  return {
    dados,
    eventos,
    calendarOutbox,
    ordemOperacoes,
    async connect() {
      let liberar;
      let snapshot;
      return {
        async query(sql, parametros = []) {
          const normalizado = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (normalizado === "begin") {
            const anterior = fila;
            fila = new Promise((resolve) => { liberar = resolve; });
            await anterior;
            snapshot = { dados: structuredClone(dados), calendarOutbox: structuredClone([...calendarOutbox]) };
            return { rows: [] };
          }
          if (normalizado === "commit") {
            liberar?.();
            return { rows: [] };
          }
          if (normalizado === "rollback") {
            if (snapshot) {
              dados.charge = snapshot.dados.charge;
              dados.reservation = snapshot.dados.reservation;
              calendarOutbox.clear();
              for (const [key, value] of snapshot.calendarOutbox) calendarOutbox.set(key, value);
            }
            liberar?.();
            return { rows: [] };
          }
          if (normalizado.startsWith("select c.*")) {
            return { rows: [{
              ...dados.charge,
              reserva_id: dados.reservation.id,
              reserva_cobranca_id: dados.reservation.cobranca_id,
              reserva_cliente_uid: dados.reservation.cliente_uid,
              reserva_servico_id: dados.reservation.servico_id,
              reserva_estado: dados.reservation.estado,
              reserva_vence_em: dados.reservation.vence_em,
              inicio_minuto: dados.reservation.inicio_minuto,
              fim_minuto: dados.reservation.fim_minuto,
              reserva_agendamento_id: dados.reservation.agendamento_id,
              reserva_data_iso: dados.reservation.data_iso,
            }] };
          }
          if (normalizado.startsWith("update public.pix_reservas")) {
            if (falhar) {
              falhar = false;
              throw new Error("PostgreSQL indisponivel");
            }
            dados.reservation.estado = "confirmada";
            dados.reservation.agendamento_id = parametros[1];
            ordemOperacoes.push("postgres-reserva-confirmada");
            return { rowCount: 1, rows: [] };
          }
          if (normalizado.startsWith("update public.pix_cobrancas")) {
            dados.charge.agendamento_id = parametros[1];
            return { rowCount: 1, rows: [] };
          }
          if (normalizado.startsWith("insert into public.pix_eventos")) {
            eventos.add(parametros[1]);
            return { rowCount: 1, rows: [] };
          }
          if (normalizado.startsWith("insert into public.pix_calendar_outbox")) {
            ordemOperacoes.push("calendar-enfileirado");
            calendarOutbox.set(parametros[0], {
              event_id: parametros[0], agendamento_id: parametros[1], nome_cliente: parametros[2],
              servico: parametros[3], data_servico: parametros[4], horario: parametros[5], duracao_minutos: parametros[6]
            });
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`SQL de teste nao previsto: ${normalizado}`);
        },
        release() {},
      };
    },
  };
}

function criarConfirmadorFirestore() {
  const documentos = new Map();
  let criacoes = 0;
  return {
    documentos,
    get criacoes() { return criacoes; },
    async confirmar({ cobranca, reserva }) {
      const agendamentoId = gerarIdAgendamentoPix(cobranca.id);
      if (documentos.has(agendamentoId)) {
        return { agendamentoId, criado: false, status: "confirmado" };
      }
      if (
        reserva.estado === "expirada" ||
        new Date(reserva.vence_em).getTime() <= Date.now()
      ) {
        throw new Error("Reserva vencida ou indisponivel");
      }
      documentos.set(agendamentoId, { status: "confirmado" });
      criacoes += 1;
      return { agendamentoId, criado: true, status: "confirmado" };
    },
  };
}

function requestComJson(dados) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(dados));
    },
  };
}

function respostaJson() {
  return {
    status: null,
    corpo: null,
    writeHead(status) { this.status = status; },
    end(corpo) { this.corpo = JSON.parse(corpo); },
  };
}

function assinarNotificacaoOrder({ pedidoId, requisicaoId, segredo, ts = String(Date.now()) }) {
  const manifesto = `id:${pedidoId};request-id:${requisicaoId};ts:${ts};`;
  const v1 = createHmac("sha256", segredo).update(manifesto).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

function requestWebhookOrder({ pedidoId, segredo, requisicaoId = "2066ca19-c6f1-498a-be75-1923005edd06", ts, liveMode = false }) {
  const dados = {
    action: "order.processed",
    api_version: "v1",
    application_id: "8920176425844272",
    data: { id: pedidoId, status: "processed", status_detail: "accredited" },
    live_mode: liveMode,
    type: "order"
  };
  return {
    url: `/pix/webhook?data.id=${encodeURIComponent(pedidoId)}&type=order`,
    headers: {
      "x-signature": assinarNotificacaoOrder({ pedidoId, requisicaoId, segredo, ts }),
      "x-request-id": requisicaoId
    },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(dados)); }
  };
}

test("somente pagamento processed/accredited passa na validacao", () => {
  assert.equal(validarRetornoPagamentoPix(aprovado, cobrancaBase).creditado, true);
  const pendente = validarRetornoPagamentoPix({
    ...aprovado,
    statusPedido: "action_required",
    detalhePedido: "waiting_transfer",
    statusPagamento: "pending",
    detalhePagamento: "pending_waiting_transfer",
  }, cobrancaBase);
  assert.equal(pendente.creditado, false);
  assert.equal(pendente.situacao, "aguardando_pagamento");
  assert.equal(validarRetornoPagamentoPix({ ...aprovado, statusPedido: "expired" }, cobrancaBase).situacao, "expirada");
});

test("divergencia de valor, referencia ou Order e rejeitada", () => {
  assert.throws(() => validarRetornoPagamentoPix({ ...aprovado, valorPagamento: "19.99" }, cobrancaBase));
  assert.throws(() => validarRetornoPagamentoPix({ ...aprovado, referenciaExterna: "outra" }, cobrancaBase));
  assert.throws(() => validarRetornoPagamentoPix({ ...aprovado, pedidoId: "outra" }, cobrancaBase));
});

test("pagamento aprovado chama conciliacao e efetivacao automaticamente", async () => {
  const anterior = process.env.PIX_TEST_ORDERS_ENABLED;
  process.env.PIX_TEST_ORDERS_ENABLED = "true";
  const ordem = [];
  const resposta = respostaJson();
  const pool = {
    async query() {
      return { rows: [{ ...cobrancaBase, estado_reserva: "reservada" }] };
    },
  };
  try {
    await consultarStatusPagamentoPix(
      requestComJson({ reservaId: "b52cf512-e0c4-4d71-b3ca-0ef72b0b42bc" }),
      resposta,
      pool,
      {
        verificarUsuario: async () => "cliente-1",
        consultarPedido: async () => aprovado,
        registrarCredito: async () => {
          ordem.push("postgres-creditado");
          return { situacao: "pago_aguardando_agendamento", agendamentoConfirmado: false };
        },
        efetivarAgendamento: async () => {
          ordem.push("firestore-confirmado");
          return { situacao: "agendamento_confirmado", agendamentoConfirmado: true, agendamentoId: "pix_6d8f562d5e854bc89705932158e7c2a9" };
        },
      },
    );
    assert.equal(resposta.status, 200);
    assert.equal(resposta.corpo.pagamentoCreditado, true);
    assert.equal(resposta.corpo.agendamentoConfirmado, true);
    assert.match(resposta.corpo.agendamentoId, /^pix_/);
    assert.deepEqual(ordem, ["postgres-creditado", "firestore-confirmado"]);
  } finally {
    if (anterior === undefined) delete process.env.PIX_TEST_ORDERS_ENABLED;
    else process.env.PIX_TEST_ORDERS_ENABLED = anterior;
  }
});

test("pagamento pendente nunca dispara confirmacao do agendamento", async () => {
  const anterior = process.env.PIX_TEST_ORDERS_ENABLED;
  process.env.PIX_TEST_ORDERS_ENABLED = "true";
  const resposta = respostaJson();
  let chamadasFinanceiras = 0;
  const pendente = {
    ...aprovado,
    statusPedido: "action_required",
    detalhePedido: "waiting_transfer",
    statusPagamento: "pending",
    detalhePagamento: "pending_waiting_transfer",
  };
  try {
    await consultarStatusPagamentoPix(
      requestComJson({ reservaId: "b52cf512-e0c4-4d71-b3ca-0ef72b0b42bc" }),
      resposta,
      { async query() { return { rows: [{ ...cobrancaBase }] }; } },
      {
        verificarUsuario: async () => "cliente-1",
        consultarPedido: async () => pendente,
        registrarCredito: async () => { chamadasFinanceiras += 1; },
        efetivarAgendamento: async () => { chamadasFinanceiras += 1; },
      },
    );
    assert.equal(resposta.status, 200);
    assert.equal(resposta.corpo.pagamentoCreditado, false);
    assert.equal(resposta.corpo.agendamentoConfirmado, false);
    assert.equal(chamadasFinanceiras, 0);
  } finally {
    if (anterior === undefined) delete process.env.PIX_TEST_ORDERS_ENABLED;
    else process.env.PIX_TEST_ORDERS_ENABLED = anterior;
  }
});

test("Order expirada encerra cobranca e libera reserva de forma transacional", async () => {
  const estado = { cobranca: "pendente", reserva: "reservada", evento: null };
  const pool = {
    async connect() {
      return {
        async query(sql, parametros = []) {
          const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (["begin", "commit", "rollback"].includes(q)) return { rows: [] };
          if (q.startsWith("select c.estado")) {
            return { rows: [{ estado: estado.cobranca, reserva_estado: estado.reserva }] };
          }
          if (q.startsWith("update public.pix_cobrancas")) {
            estado.cobranca = parametros[1];
            return { rowCount: 1, rows: [] };
          }
          if (q.startsWith("update public.pix_reservas")) {
            estado.reserva = parametros[1];
            return { rowCount: 1, rows: [] };
          }
          if (q.startsWith("insert into public.pix_eventos")) {
            estado.evento = parametros[2];
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`SQL de teste nao previsto: ${q}`);
        },
        release() {},
      };
    },
  };
  const encerramento = await encerrarCobrancaPixSemPagamento({
    pool,
    cobrancaId: cobrancaBase.id,
    uid: cobrancaBase.cliente_uid,
    situacao: "expirada",
  });
  assert.deepEqual(encerramento, { situacao: "expirada", agendamentoConfirmado: false });
  assert.deepEqual(estado, { cobranca: "expirada", reserva: "expirada", evento: "expirada" });
});

test("reserva vencida preserva pagamento para analise e bloqueia novo agendamento", async () => {
  const situacao = classificarReservaAposCredito(
    "expirada",
    new Date(Date.now() - 60000).toISOString(),
    null,
  );
  assert.deepEqual(situacao, { situacao: "pago_requer_analise", agendamentoConfirmado: false });
  assert.throws(() => validarReservaVigentePix({
    estado: "expirada",
    vence_em: new Date(Date.now() + 60000).toISOString(),
    inicio_minuto: 600,
    fim_minuto: 660,
    data_iso: "2099-01-01",
  }), /vencida/);

  const pool = criarPoolEfetivacao({
    estado: criarEstadoPg({ reservaEstado: "expirada", venceEm: Date.now() - 60000 }),
  });
  const fs = criarConfirmadorFirestore();
  await assert.rejects(
    efetivarAgendamentoPix({
      pool,
      cobrancaId: cobrancaBase.id,
      uid: cobrancaBase.cliente_uid,
      dependencias: { obterNomeCliente: async () => "Cliente Teste", confirmarFirestore: fs.confirmar },
    }),
    /requer conciliacao|Reserva vencida/i,
  );
  assert.equal(fs.criacoes, 0);
  assert.equal(pool.dados.reservation.estado, "expirada");
});

test("agenda Calendar entra na outbox só após confirmação e é idempotente", async () => {
  const pool = criarPoolEfetivacao();
  const fs = criarConfirmadorFirestore();
  const dependencias = { obterNomeCliente: async () => "Cliente Teste", confirmarFirestore: fs.confirmar };
  await efetivarAgendamentoPix({ pool, cobrancaId: cobrancaBase.id, uid: cobrancaBase.cliente_uid, dependencias });
  await efetivarAgendamentoPix({ pool, cobrancaId: cobrancaBase.id, uid: cobrancaBase.cliente_uid, dependencias });
  assert.equal(fs.criacoes, 1);
  assert.equal(pool.calendarOutbox.size, 1);
  const [evento] = pool.calendarOutbox.values();
  assert.equal(evento.event_id, `evt_${gerarIdAgendamentoPix(cobrancaBase.id)}`);
  assert.equal(evento.nome_cliente, "Cliente Teste");
  assert.equal(evento.servico, "Manicure Simples");
  assert.equal(evento.duracao_minutos, 60);
  assert.ok(pool.ordemOperacoes.indexOf("postgres-reserva-confirmada") < pool.ordemOperacoes.indexOf("calendar-enfileirado"));
});

test("worker Calendar envia somente campos autorizados com eventId estável e marca sucesso", async () => {
  const evento = { id: 9, event_id: "evt_pix_123", nome_cliente: "Cliente", servico: "Manicure", data_servico: new Date("2099-01-01T00:00:00.000Z"), data_servico_iso: "2099-01-01", horario: "10:00:00", duracao_minutos: 60, tentativas: 1 };
  const atualizacoes = [];
  let consultaWorker = "";
  const pool = {
    async connect() {
      return { async query(sql) {
        const q = sql.replace(/\s+/g, " ").toLowerCase();
        if (["begin", "commit", "rollback"].includes(q)) return { rows: [] };
        if (q.includes("with proximo as")) { consultaWorker = sql; return { rows: [evento] }; }
        throw new Error(`SQL inesperado: ${q}`);
      }, release() {} };
    },
    async query(sql, params) { atualizacoes.push({ sql, params }); return { rowCount: 1 }; }
  };
  let enviado;
  const resultado = await processarProximaSincronizacaoCalendar(pool, async (row) => { enviado = montarPayloadCalendar(row); });
  assert.deepEqual(resultado, { processado: true, enviado: true, eventId: evento.event_id });
  assert.deepEqual(Object.keys(enviado).sort(), ["acao", "dataInicio", "duracaoMinutos", "eventId", "nomeCliente", "servico"].sort());
  assert.deepEqual(enviado, { acao: "AGENDAR", nomeCliente: "Cliente", servico: "Manicure", dataInicio: "2099-01-01T10:00:00", duracaoMinutos: 60, eventId: evento.event_id });
  assert.match(consultaWorker, /TO_CHAR\(fila\.data_servico, 'YYYY-MM-DD'\) AS data_servico_iso/i);
  assert.match(atualizacoes[0].sql, /status = 'enviado'/);
});

test("payload Calendar serializa data YYYY-MM-DD recebida como string ou Date", () => {
  const base = { nome_cliente: "Cliente", servico: "Manicure", horario: "10:00:00", duracao_minutos: 60, event_id: "evt_data" };
  assert.equal(montarPayloadCalendar({ ...base, data_servico: "2026-10-15" }).dataInicio, "2026-10-15T10:00:00");
  assert.equal(montarPayloadCalendar({ ...base, data_servico: new Date("2026-10-15T00:00:00.000Z") }).dataInicio, "2026-10-15T10:00:00");
  assert.equal(montarPayloadCalendar({ ...base, data_servico: new Date("2026-10-14T23:00:00.000Z"), data_servico_iso: "2026-10-15" }).dataInicio, "2026-10-15T10:00:00");
});

test("falha do Apps Script mantém agendamento e agenda retry durável sem request real", async () => {
  const evento = { id: 10, event_id: "evt_pix_retry", nome_cliente: "Cliente", servico: "Manicure", data_servico: "2099-01-01", horario: "10:00:00", duracao_minutos: 60, tentativas: 1 };
  const atualizacoes = [];
  const pool = {
    async connect() { return { async query(sql) { if (/begin|commit|rollback/i.test(sql.trim())) return { rows: [] }; return { rows: [evento] }; }, release() {} }; },
    async query(sql, params) { atualizacoes.push({ sql, params }); return { rowCount: 1 }; }
  };
  let chamadas = 0;
  let payloadEnviado;
  const resultado = await processarProximaSincronizacaoCalendar(pool, async (row) => {
    chamadas += 1;
    await enviarEventoCalendar(row, async (url, options) => {
      payloadEnviado = JSON.parse(options.body);
      assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\//);
      return { ok: true, status: 200, async text() { return JSON.stringify({ status: "error", message: "calendar unavailable" }); } };
    });
  });
  assert.deepEqual(resultado, { processado: true, enviado: false, eventId: evento.event_id });
  assert.equal(chamadas, 1);
  assert.equal(payloadEnviado.eventId, evento.event_id);
  assert.match(atualizacoes[0].sql, /status = 'pendente'/);
  assert.equal(atualizacoes[0].params[1], 30);
});

test("ambientes Mercado Pago são separados e produção fica desativada por padrão", () => {
  const envAnterior = { ...process.env };
  try {
    delete process.env.MP_ENVIRONMENT;
    delete process.env.PIX_PRODUCTION_ORDERS_ENABLED;
    delete process.env.MP_ACCESS_TOKEN_PRODUCTION;
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    assert.equal(ambienteMercadoPagoAtual(), "test");
    assert.equal(mercadoPagoHabilitado("test"), true);
    assert.equal(mercadoPagoHabilitado("production"), false);
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "true";
    assert.equal(mercadoPagoHabilitado("production"), false, "produção exige o token de produção");
    process.env.MP_ACCESS_TOKEN_PRODUCTION = "APP_USR-production-token";
    assert.equal(mercadoPagoHabilitado("production"), true, "polling de produção não depende de segredo de webhook");
    const dados = { valorCentavos: 2000, referenciaExterna: "isabele_pix_123", chaveIdempotencia: "6d8f562d-5e85-4bc8-9705-932158e7c2a9", emailPagador: "cliente@example.com" };
    assert.equal(montarPedidoPix({ ...dados, ambiente: "test" }).payer.first_name, "APRO");
    assert.equal("first_name" in montarPedidoPix({ ...dados, ambiente: "production" }).payer, false);
    process.env.MP_ENVIRONMENT = "production";
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "false";
    assert.equal(mercadoPagoHabilitado(), false);
  } finally {
    for (const chave of Object.keys(process.env)) if (!(chave in envAnterior)) delete process.env[chave];
    Object.assign(process.env, envAnterior);
  }
});

test("credenciais e payloads do Mercado Pago usam o ambiente persistido sem chamada real", async () => {
  const anterior = { ...process.env };
  const fetchAnterior = globalThis.fetch;
  const chamadas = [];
  try {
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "true";
    process.env.MP_ACCESS_TOKEN_TEST = "APP_USR-test-token";
    process.env.MP_ACCESS_TOKEN_PRODUCTION = "APP_USR-production-token";
    process.env.MP_WEBHOOK_SECRET_PRODUCTION = "mock-production-webhook-secret";
    globalThis.fetch = async (url, options) => {
      chamadas.push({ url, options });
      return { ok: true, async json() { return { id: "order-1", external_reference: "isabele_pix_123", total_amount: "20.00", status: "action_required", transactions: { payments: [{ amount: "20.00", status: "pending", payment_method: { id: "pix" } }] } }; } };
    };
    const dados = { valorCentavos: 2000, referenciaExterna: "isabele_pix_123", chaveIdempotencia: "6d8f562d-5e85-4bc8-9705-932158e7c2a9", emailPagador: "cliente@example.com" };
    await criarPedidoPix(dados, "test");
    await criarPedidoPix(dados, "production");
    assert.equal(chamadas.length, 2);
    assert.equal(chamadas[0].options.headers.Authorization, "Bearer APP_USR-test-token");
    assert.equal(chamadas[1].options.headers.Authorization, "Bearer APP_USR-production-token");
    assert.equal(JSON.parse(chamadas[0].options.body).payer.first_name, "APRO");
    assert.equal("first_name" in JSON.parse(chamadas[1].options.body).payer, false);
  } finally {
    globalThis.fetch = fetchAnterior;
    for (const chave of Object.keys(process.env)) if (!(chave in anterior)) delete process.env[chave];
    Object.assign(process.env, anterior);
  }
});

test("confirmacao concorrente usa um documento Firestore deterministico", async () => {
  const pool = criarPoolEfetivacao();
  const fs = criarConfirmadorFirestore();
  const efetivar = () => efetivarAgendamentoPix({
    pool,
    cobrancaId: cobrancaBase.id,
    uid: cobrancaBase.cliente_uid,
    dependencias: { obterNomeCliente: async () => "Cliente Teste", confirmarFirestore: fs.confirmar },
  });

  const [a, b] = await Promise.all([efetivar(), efetivar()]);
  assert.equal(a.agendamentoId, b.agendamentoId);
  assert.equal(fs.criacoes, 1);
  assert.equal(fs.documentos.size, 1);
  assert.equal(pool.dados.reservation.estado, "confirmada");
});

test("repeticao do credito usa o bloqueio transacional e chave de evento unica", async () => {
  const dados = {
    charge: { ...cobrancaBase, estado: "pendente", pago_em: null },
    reservation: {
      estado: "reservada",
      vence_em: new Date(Date.now() + 60000).toISOString(),
      agendamento_id: null,
    },
  };
  let fila = Promise.resolve();
  const eventos = new Set();
  const pool = {
    async connect() {
      let liberar;
      return {
        async query(sql, parametros = []) {
          const q = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (q === "begin") {
            const anterior = fila;
            fila = new Promise((resolve) => { liberar = resolve; });
            await anterior;
            return { rows: [] };
          }
          if (q === "commit" || q === "rollback") {
            liberar?.();
            return { rows: [] };
          }
          if (q.startsWith("select c.id")) {
            return { rows: [{
              ...dados.charge,
              reserva_estado: dados.reservation.estado,
              reserva_vence_em: dados.reservation.vence_em,
              agendamento_id: dados.reservation.agendamento_id,
            }] };
          }
          if (q.startsWith("update public.pix_cobrancas")) {
            dados.charge.estado = "paga";
            dados.charge.pago_em ||= new Date().toISOString();
            return { rowCount: 1, rows: [] };
          }
          if (q.startsWith("insert into public.pix_eventos")) {
            eventos.add(parametros[1]);
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`SQL de teste nao previsto: ${q}`);
        },
        release() {},
      };
    },
  };

  const registrar = () => registrarCreditoPix({
    pool, cobrancaId: cobrancaBase.id, uid: cobrancaBase.cliente_uid, pedido: aprovado,
  });
  const resultados = await Promise.all([registrar(), registrar()]);
  assert.equal(dados.charge.estado, "paga");
  assert.equal(eventos.size, 1);
  assert.equal(resultados.every((item) => item.situacao === "pago_aguardando_agendamento"), true);
});

test("falha do Firestore nao confirma a reserva no PostgreSQL", async () => {
  const pool = criarPoolEfetivacao();
  const erroFs = new Error("Firestore temporariamente indisponivel");
  await assert.rejects(
    efetivarAgendamentoPix({
      pool,
      cobrancaId: cobrancaBase.id,
      uid: cobrancaBase.cliente_uid,
      dependencias: {
        obterNomeCliente: async () => "Cliente Teste",
        confirmarFirestore: async () => { throw erroFs; },
      },
    }),
    /Firestore temporariamente indisponivel/,
  );
  assert.equal(pool.dados.reservation.estado, "reservada");
  assert.equal(pool.dados.charge.agendamento_id, undefined);
});

test("falha PostgreSQL apos gravacao Firestore e recuperavel sem duplicar documento", async () => {
  const pool = criarPoolEfetivacao({ falharUmaVezEmReserva: true });
  const fs = criarConfirmadorFirestore();
  const efetivar = () => efetivarAgendamentoPix({
    pool,
    cobrancaId: cobrancaBase.id,
    uid: cobrancaBase.cliente_uid,
    dependencias: { obterNomeCliente: async () => "Cliente Teste", confirmarFirestore: fs.confirmar },
  });

  await assert.rejects(efetivar(), /PostgreSQL indisponivel/);
  assert.equal(fs.criacoes, 1);
  assert.equal(pool.dados.reservation.estado, "reservada");
  const recuperado = await efetivar();
  assert.equal(recuperado.agendamentoConfirmado, true);
  assert.equal(fs.criacoes, 1);
  assert.equal(pool.dados.reservation.estado, "confirmada");
});

test("ID de agendamento e estavel e conflito de horario respeita duracao", () => {
  const id = gerarIdAgendamentoPix(cobrancaBase.id);
  assert.equal(id, gerarIdAgendamentoPix(cobrancaBase.id));
  assert.equal(encontrarConflitoAgendamentoPix([
    { status: "confirmado", horario: "10:00", duracao: 60 },
  ], 630, 690), true);
  assert.equal(encontrarConflitoAgendamentoPix([
    { status: "agendado", horario: "10:00", duracao: 60 },
  ], 660, 720), false);
});

test("documento do agendamento preserva cliente, servico, valores e duracao", () => {
  const reserva = {
    id: "b52cf512-e0c4-4d71-b3ca-0ef72b0b42bc",
    cobranca_id: cobrancaBase.id,
    cliente_uid: cobrancaBase.cliente_uid,
    servico_id: "manicure",
    inicio_minuto: 600,
    fim_minuto: 660,
    data_iso: "2026-10-15",
  };
  const documento = montarAgendamentoPix({ cobranca: cobrancaBase, reserva, nomeCliente: "Cliente Teste" });
  assert.equal(documento.nomeCliente, "Cliente Teste");
  assert.equal(documento.horario, "10:00");
  assert.equal(documento.precoSnapshot, 30);
  assert.equal(documento.duracao, 60);
  assert.equal(documento.valorSinalCentavos + documento.valorRestanteCentavos, 3000);
});

test("duracao ausente mantém compatibilidade; duracao explicitamente invalida falha", () => {
  assert.equal(obterDuracaoAgendamentoPix(undefined), 90);
  assert.equal(obterDuracaoAgendamentoPix(null), 90);
  for (const valor of [0, -5, "texto", 1441, 2.5]) {
    assert.throws(() => obterDuracaoAgendamentoPix(valor), /duracao invalida/i);
  }
  assert.throws(() => encontrarConflitoAgendamentoPix([
    { status: "confirmado", horario: "10:00", duracao: 0 },
  ], 600, 660), /duracao invalida/i);
});

test("novo agendamento PIX confirmado notifica cliente e profissional uma unica vez", () => {
  const atual = {
    id: "pix-1", status: "confirmado", origemPagamento: "mercado_pago_pix",
    nomeCliente: "Ana Lima", servico: "Manicure", data: "2026-10-15",
    horario: "10:00", clienteId: "cliente-1"
  };
  const eventos = identificarNotificacoesAgendamento(null, atual);
  assert.equal(eventos.length, 2);
  assert.deepEqual(eventos.map(({ destinatario }) => destinatario), ["cliente", "admin"]);
  assert.equal(eventos[0].titulo, "Agendamento confirmado!");
  assert.match(eventos[0].mensagem, /PIX foi aprovado/);
  assert.equal(eventos[1].titulo, "Novo agendamento confirmado!");
  assert.match(eventos[1].mensagem, /Ana Lima confirmou o atendimento de Manicure/);
  assert.deepEqual(identificarNotificacoesAgendamento({ status: "confirmado" }, atual), []);
});

test("Order aprovada recebida pelo webhook concilia e efetiva sem depender do navegador", async () => {
  let creditos = 0;
  let efetivacoes = 0;
  const pool = { query: async () => ({ rows: [{ ...cobrancaBase, mp_environment: "test" }] }) };
  const resultado = await processarOrderNotificada(pool, cobrancaBase.mp_order_id, "test", {
    consultarPedido: async () => aprovado,
    registrarCredito: async () => { creditos++; return { situacao: "pago_aguardando_agendamento" }; },
    efetivarAgendamento: async () => { efetivacoes++; return { agendamentoConfirmado: true }; }
  });
  assert.deepEqual(resultado, {
    concluido: true,
    situacao: "agendamento_confirmado",
    pagamentoCreditado: true,
    agendamentoConfirmado: true,
  });
  assert.equal(creditos, 1);
  assert.equal(efetivacoes, 1);
});

test("polling consulta Order aprovada no backend e confirma sem webhook ou navegador", async () => {
  const envAnterior = { ...process.env };
  const cobranca = {
    id: cobrancaBase.id,
    cliente_uid: cobrancaBase.cliente_uid,
    mp_environment: "test",
    mp_order_id: cobrancaBase.mp_order_id,
    estado: "pendente",
    pix_polling_attempts: 1,
    criado_em: new Date(Date.now() - 30000).toISOString(),
    vence_em: new Date(Date.now() + 60000).toISOString(),
  };
  let credito = 0;
  let efetivacao = 0;
  let consultaOrder = 0;
  const atualizacoes = [];
  const pool = {
    async query(sql, parametros = []) {
      const consulta = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (consulta.startsWith("select c.* from public.pix_cobrancas")) {
        consultaOrder += 1;
        return { rows: [{ ...cobrancaBase, mp_environment: "test" }] };
      }
      throw new Error(`SQL nao previsto no teste: ${consulta}`);
    },
  };

  try {
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "false";
    process.env.MP_ACCESS_TOKEN_TEST = "APP_USR-test-token";
    delete process.env.MP_ACCESS_TOKEN_PRODUCTION;

    const lote = await processarCicloPixPolling(pool, {
      config: { habilitado: true, ambientes: ["test"], limiteLote: 5, limitePorMinuto: 60, horizonteHoras: 72 },
      adquirirLock: async () => ({}),
      liberarLock: async () => {},
      reservar: async (db, config) => {
        assert.deepEqual(config.ambientes, ["test"]);
        return [cobranca];
      },
      salvarResultado: async (_db, _cobranca, resultado) => atualizacoes.push(resultado),
      processarOrder: (id, ambiente) => processarOrderNotificada(pool, id, ambiente, {
        consultarPedido: async () => aprovado,
        registrarCredito: async () => {
          credito += 1;
          return { situacao: "pago_aguardando_agendamento" };
        },
        efetivarAgendamento: async () => {
          efetivacao += 1;
          return { agendamentoConfirmado: true };
        },
      }),
    });

    assert.equal(lote.situacao, "processado");
    assert.equal(lote.elegiveis, 1);
    assert.equal(lote.consultas, 1);
    assert.equal(lote.conciliadas, 1);
    assert.equal(consultaOrder, 1);
    assert.equal(credito, 1);
    assert.equal(efetivacao, 1);
    assert.deepEqual(atualizacoes, [{ proximaEmSegundos: null, erro: null }]);
  } finally {
    for (const chave of Object.keys(process.env)) if (!(chave in envAnterior)) delete process.env[chave];
    Object.assign(process.env, envAnterior);
  }
});

test("polling reprograma Orders pendentes, respeita Retry-After e limita erros", async () => {
  const envAnterior = { ...process.env };
  const atualizacoes = [];
  const ordem = {
    id: cobrancaBase.id,
    cliente_uid: cobrancaBase.cliente_uid,
    mp_environment: "test",
    mp_order_id: cobrancaBase.mp_order_id,
    estado: "pendente",
    pix_polling_attempts: 4,
    criado_em: new Date(Date.now() - 900000).toISOString(),
    vence_em: new Date(Date.now() - 600000).toISOString(),
  };

  try {
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "false";
    process.env.MP_ACCESS_TOKEN_TEST = "APP_USR-test-token";
    const lote = await processarCicloPixPolling({}, {
      config: { habilitado: true, ambientes: ["test"], limiteLote: 5, limitePorMinuto: 60, horizonteHoras: 72 },
      adquirirLock: async () => ({}),
      liberarLock: async () => {},
      reservar: async () => [ordem],
      salvarResultado: async (_pool, _ordem, resultado) => atualizacoes.push(resultado),
      processarOrder: async () => { throw Object.assign(new Error("429"), { status: 429, retryAfterSeconds: 47 }); },
    });
    assert.equal(lote.erros, 1, "erro é categorizado e remarcado");
    assert.equal(lote.consultas, 1);
    assert.equal(atualizacoes.length, 1);
    assert.equal(atualizacoes[0].proximaEmSegundos, 47, "Retry-After não é encurtado");
    assert.equal(atualizacoes[0].erro, "rate_limited");
  } finally {
    for (const chave of Object.keys(process.env)) if (!(chave in envAnterior)) delete process.env[chave];
    Object.assign(process.env, envAnterior);
  }
});

test("Mercado Pago 429 honra Retry-After, HTTP 5xx e timeout são recuperáveis", async () => {
  const anterior = { ...process.env };
  const fetchAnterior = globalThis.fetch;
  try {
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    process.env.MP_ACCESS_TOKEN_TEST = "APP_USR-test-token";
    globalThis.fetch = async () => ({
      ok: false,
      status: 429,
      headers: { get: (nome) => nome === "retry-after" ? "37" : null },
    });
    await assert.rejects(consultarPedidoPix("order-429", "test"), (erro) => {
      assert.equal(erro.status, 429);
      assert.equal(erro.retryAfterSeconds, 37);
      return true;
    });

    globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null } });
    await assert.rejects(consultarPedidoPix("order-503", "test"), (erro) => erro.status === 503);

    globalThis.fetch = async () => { throw new DOMException("request timed out", "TimeoutError"); };
    await assert.rejects(consultarPedidoPix("order-timeout", "test"), (erro) => erro.name === "TimeoutError");
  } finally {
    globalThis.fetch = fetchAnterior;
    for (const chave of Object.keys(process.env)) if (!(chave in anterior)) delete process.env[chave];
    Object.assign(process.env, anterior);
  }
});

test("worker desligado por padrão e fila vazia não consultam Orders", async () => {
  const anterior = { ...process.env };
  let reservas = 0;
  try {
    delete process.env.PIX_POLLING_WORKER_ENABLED;
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "false";
    process.env.MP_ACCESS_TOKEN_TEST = "APP_USR-test-token";
    process.env.MP_ACCESS_TOKEN_PRODUCTION = "APP_USR-production-token";
    assert.equal(configuracaoPixPolling().habilitado, false);
    assert.deepEqual(configuracaoPixPolling().ambientes, ["test"]);

    const desabilitado = await processarCicloPixPolling({}, { config: { habilitado: false, ambientes: ["test"] } });
    assert.equal(desabilitado.situacao, "desabilitado");

    const vazio = await processarCicloPixPolling({}, {
      config: { habilitado: true, ambientes: ["test"], limiteLote: 5, limitePorMinuto: 60, horizonteHoras: 72 },
      adquirirLock: async () => ({}), liberarLock: async () => {},
      reservar: async () => { reservas += 1; return []; },
      processarOrder: async () => assert.fail("fila vazia não chama Mercado Pago"),
    });
    assert.equal(vazio.consultas, 0);
    assert.equal(vazio.elegiveis, 0);
    assert.equal(reservas, 1);
  } finally {
    for (const chave of Object.keys(process.env)) if (!(chave in anterior)) delete process.env[chave];
    Object.assign(process.env, anterior);
  }
});

test("pagamento já creditado retoma apenas a efetivação local, sem nova consulta", async () => {
  const atualizacoes = [];
  let efetivacoes = 0;
  const paga = {
    id: cobrancaBase.id, cliente_uid: cobrancaBase.cliente_uid,
    mp_environment: "test", mp_order_id: cobrancaBase.mp_order_id,
    estado: "paga", pix_polling_attempts: 2,
    criado_em: new Date(0).toISOString(), vence_em: new Date(0).toISOString(),
  };
  const resultado = await processarCicloPixPolling({}, {
    config: { habilitado: true, ambientes: ["test"], limiteLote: 5, limitePorMinuto: 60, horizonteHoras: 72 },
    adquirirLock: async () => ({}), liberarLock: async () => {},
    reservar: async () => [paga],
    salvarResultado: async (_pool, _cobranca, dado) => atualizacoes.push(dado),
    processarOrder: async () => assert.fail("cobrança paga não consulta Mercado Pago"),
    efetivarAgendamento: async () => { efetivacoes += 1; return { agendamentoConfirmado: true }; },
  });
  assert.equal(resultado.consultas, 0);
  assert.equal(resultado.recuperacoesLocais, 1);
  assert.equal(resultado.conciliadas, 1);
  assert.equal(efetivacoes, 1);
  assert.deepEqual(atualizacoes[0], { proximaEmSegundos: null, erro: null });
});

test("pagamento tardio é creditado, não cria novo horário e sai do polling para análise", async () => {
  const atualizacoes = [];
  const pendente = {
    id: cobrancaBase.id, cliente_uid: cobrancaBase.cliente_uid,
    mp_environment: "test", mp_order_id: cobrancaBase.mp_order_id,
    estado: "pendente", pix_polling_attempts: 5,
    criado_em: new Date(Date.now() - 3600000).toISOString(),
    vence_em: new Date(Date.now() - 1800000).toISOString(),
  };
  const pool = { query: async () => ({ rows: [{ ...cobrancaBase, mp_environment: "test" }] }) };
  let creditado = false;
  let tentouCriarAgendamento = false;
  const resultado = await processarCicloPixPolling(pool, {
    config: { habilitado: true, ambientes: ["test"], limiteLote: 5, limitePorMinuto: 60, horizonteHoras: 72 },
    adquirirLock: async () => ({}), liberarLock: async () => {},
    reservar: async () => [pendente],
    salvarResultado: async (_pool, _charge, dado) => atualizacoes.push(dado),
    processarOrder: (id, ambiente) => processarOrderNotificada(pool, id, ambiente, {
      consultarPedido: async () => aprovado,
      registrarCredito: async () => { creditado = true; return { situacao: "pago_requer_analise" }; },
      efetivarAgendamento: async () => {
        tentouCriarAgendamento = true;
        throw Object.assign(new Error("reserva vencida"), { requerAnalise: true });
      },
    }),
  });
  assert.equal(creditado, true);
  assert.equal(tentouCriarAgendamento, true);
  assert.equal(resultado.conciliadas, 1);
  assert.equal(resultado.aguardandoAnalise, 1);
  assert.deepEqual(atualizacoes[0], { proximaEmSegundos: null, erro: null });
});

test("seleção de polling é limitada, usa lease e ignora cobranças finalizadas/antigas", async () => {
  let consulta;
  const pool = { async query(sql, parametros) { consulta = { sql: sql.replace(/\s+/g, " ").toLowerCase(), parametros }; return { rows: [] }; } };
  await reservarCobrancasElegiveis(pool, {
    limiteLote: 3, ambientes: ["test"], horizonteHoras: 72,
  });
  assert.match(consulta.sql, /limit \$1 for update of c skip locked/);
  assert.match(consulta.sql, /pix_polling_next_at <= now\(\)/);
  assert.match(consulta.sql, /pix_polling_lease_until is null or c\.pix_polling_lease_until <= now\(\)/);
  assert.match(consulta.sql, /c\.estado = 'pendente'/);
  assert.match(consulta.sql, /c\.estado = 'paga'/);
  assert.doesNotMatch(consulta.sql, /c\.estado = 'expirada'/);
  assert.deepEqual(consulta.parametros, [3, 120, ["test"], 72]);
});

test("intervalo adaptativo cresce após a expiração da reserva", () => {
  const base = Date.now();
  const config = { intervaloInicialSegundos: 30, intervaloAposReservaSegundos: 120, intervaloAntigoSegundos: 300, intervaloFinalSegundos: 1800 };
  assert.equal(segundosProximaConsulta({ criado_em: new Date(base - 60000), vence_em: new Date(base + 60000), agora: base, config }), 30);
  assert.equal(segundosProximaConsulta({ criado_em: new Date(base - 3600000), vence_em: new Date(base - 60000), agora: base, config }), 120);
  assert.equal(segundosProximaConsulta({ criado_em: new Date(base - 43200000), vence_em: new Date(base - 43000000), agora: base, config }), 300);
});

test("consultas ao Mercado Pago usam lock por Order e só uma chamada simultânea", async () => {
  let ordemBloqueada = false;
  let chamadasMercadoPago = 0;
  let liberarConsulta;
  const consultaPausada = new Promise((resolve) => { liberarConsulta = resolve; });
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes("pg_try_advisory_lock")) {
            if (ordemBloqueada) return { rows: [{ adquirido: false }] };
            ordemBloqueada = true;
            return { rows: [{ adquirido: true }] };
          }
          if (sql.includes("SELECT window_started_at")) {
            return { rows: [{ window_started_at: new Date(), request_count: 0 }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            ordemBloqueada = false;
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const consulta = async () => {
    chamadasMercadoPago += 1;
    await consultaPausada;
    return aprovado;
  };

  const primeira = consultarPedidoPixComLock(pool, "order-1", "test", consulta);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    consultarPedidoPixComLock(pool, "order-1", "test", consulta),
    (erro) => erro.code === "PIX_CONSULTA_EM_ANDAMENTO",
  );
  liberarConsulta();
  assert.equal(await primeira, aprovado);
  assert.equal(chamadasMercadoPago, 1);
});

test("Order pendente reprograma webhook sem confirmar agendamento", async () => {
  let efetivacoes = 0;
  const pool = { query: async () => ({ rows: [{ ...cobrancaBase }] }) };
  const pendente = { ...aprovado, statusPedido: "processing", detalhePedido: "pending", statusPagamento: "pending", detalhePagamento: "pending", valorPagamento: null };
  const resultado = await processarOrderNotificada(pool, cobrancaBase.mp_order_id, "test", {
    consultarPedido: async () => pendente,
    registrarCredito: async () => assert.fail("nao pode creditar"),
    efetivarAgendamento: async () => { efetivacoes++; }
  });
  assert.equal(resultado.concluido, false);
  assert.equal(efetivacoes, 0);
});

test("HMAC da Orders API preserva a caixa original do data.id", () => {
  const pedidoId = "ORDTST01M4KT8RWNNA1QFP0E6M37VVFQ";
  const requisicaoId = "2066ca19-c6f1-498a-be75-1923005edd06";
  const segredo = "segredo-de-webhook-de-teste-local";
  const ts = "1742505638683";
  const assinaturaValida = assinarNotificacaoOrder({ pedidoId, requisicaoId, segredo, ts });
  const assinaturaComIdNormalizado = assinarNotificacaoOrder({ pedidoId: pedidoId.toLowerCase(), requisicaoId, segredo, ts });

  assert.equal(validarAssinaturaWebhookPix({ assinatura: assinaturaValida, requisicaoId, pedidoId, segredo }), true);
  assert.equal(validarAssinaturaWebhookPix({ assinatura: assinaturaComIdNormalizado, requisicaoId, pedidoId, segredo }), false);
  assert.equal(validarAssinaturaWebhookPix({ assinatura: assinaturaValida, requisicaoId, pedidoId: null, segredo }), false);
  assert.equal(validarAssinaturaWebhookPix({ assinatura: assinaturaValida, requisicaoId: null, pedidoId, segredo }), false);
  assert.equal(validarAssinaturaWebhookPix({ assinatura: null, requisicaoId, pedidoId, segredo }), false);
  assert.equal(validarAssinaturaWebhookPix({ assinatura: "ts=inválido,v1=abc", requisicaoId, pedidoId, segredo }), false);
});

test("webhook Orders de teste assinado persiste na inbox e repeticoes permanecem idempotentes", async () => {
  const anterior = { ...process.env };
  const segredo = "segredo-de-webhook-de-teste-local";
  const inbox = new Map();
  const chamadas = [];
  process.env.PIX_WEBHOOK_ENABLED = "true";
  process.env.PIX_TEST_ORDERS_ENABLED = "true";
  process.env.PIX_PRODUCTION_ORDERS_ENABLED = "false";
  process.env.MP_WEBHOOK_SECRET_TEST = segredo;
  delete process.env.MP_WEBHOOK_SECRET_PRODUCTION;
  const pool = {
    async query(sql, parametros) {
      chamadas.push({ sql, parametros });
      const chave = `${parametros[0]}:${parametros[1]}`;
      inbox.set(chave, { ambiente: parametros[0], pedidoId: parametros[1] });
      return { rowCount: 1 };
    }
  };

  try {
    for (let i = 0; i < 2; i += 1) {
      const req = requestWebhookOrder({
        pedidoId: "ORDTST01M4KT8RWNNA1QFP0E6M37VVFQ",
        segredo,
        requisicaoId: `req-test-${i}`,
        ts: String(1742505638683 + i)
      });
      const res = respostaJson();
      await atenderWebhookPix(req, res, pool);
      assert.equal(res.status, 200);
      assert.deepEqual(res.corpo, { recebido: true });
    }

    assert.equal(chamadas.length, 2);
    assert.equal(inbox.size, 1);
    assert.equal(inbox.get("test:ORDTST01M4KT8RWNNA1QFP0E6M37VVFQ").ambiente, "test");
    assert.match(chamadas[0].sql, /ON CONFLICT \(mp_environment, mp_order_id\)/i);
  } finally {
    for (const chave of Object.keys(process.env)) if (!(chave in anterior)) delete process.env[chave];
    Object.assign(process.env, anterior);
  }
});

test("webhook rejeita assinatura de segredo diferente e Order live no ambiente de teste", async () => {
  const anterior = { ...process.env };
  const segredoTeste = "segredo-de-webhook-de-teste-local";
  let persistencias = 0;
  process.env.PIX_WEBHOOK_ENABLED = "true";
  process.env.PIX_TEST_ORDERS_ENABLED = "true";
  process.env.PIX_PRODUCTION_ORDERS_ENABLED = "false";
  process.env.MP_WEBHOOK_SECRET_TEST = segredoTeste;
  delete process.env.MP_WEBHOOK_SECRET_PRODUCTION;
  const pool = { async query() { persistencias += 1; return { rowCount: 1 }; } };

  try {
    const assinaturaErrada = requestWebhookOrder({
      pedidoId: "ORDTST01M4KT8RWNNA1QFP0E6M37VVFQ", segredo: "outro-segredo",
      ts: "1742505638683"
    });
    const respostaAssinatura = respostaJson();
    const logAnterior = console.warn;
    console.warn = () => {};
    try { await atenderWebhookPix(assinaturaErrada, respostaAssinatura, pool); }
    finally { console.warn = logAnterior; }
    assert.equal(respostaAssinatura.status, 401);

    const pedidoProducao = requestWebhookOrder({
      pedidoId: "ORDTST01M4KT8RWNNA1QFP0E6M37VVFQ", segredo: segredoTeste,
      ts: "1742505638684", liveMode: true
    });
    const respostaProducao = respostaJson();
    await atenderWebhookPix(pedidoProducao, respostaProducao, pool);
    assert.equal(respostaProducao.status, 400);
    assert.equal(respostaProducao.corpo.erro, "Ambiente da notificacao divergente");
    assert.equal(persistencias, 0);
  } finally {
    for (const chave of Object.keys(process.env)) if (!(chave in anterior)) delete process.env[chave];
    Object.assign(process.env, anterior);
  }
});

test("webhook fila preserva ambiente e agenda nova tentativa apos falha temporaria", async () => {
  const chamadas = [];
  const pool = { query: async (sql, params) => {
    chamadas.push({ sql, params });
    if (chamadas.length === 1) return { rows: [{ mp_environment: "production", mp_order_id: "order-1", tentativas: 1, ultima_notificacao_em: "stamp" }] };
    return { rowCount: 1, rows: [] };
  } };
  let recebido;
  const resultado = await processarProximaNotificacaoPix(pool, async (id, ambiente) => {
    recebido = { id, ambiente };
    throw new Error("falha simulada");
  });
  assert.deepEqual(recebido, { id: "order-1", ambiente: "production" });
  assert.equal(resultado.situacao, "reagendada");
  assert.match(chamadas[1].sql, /mp_environment = \$1/);
  assert.equal(chamadas[1].params[0], "production");
});

test("pedido estornado e recusado recebem classificacao financeira especifica", () => {
  const estornado = validarRetornoPagamentoPix({
    ...aprovado, statusPedido: "refunded", detalhePedido: "refunded",
    statusPagamento: "refunded", detalhePagamento: "refunded"
  }, cobrancaBase);
  assert.equal(estornado.situacao, "estornada");
  const recusado = validarRetornoPagamentoPix({
    ...aprovado, statusPedido: "rejected", detalhePedido: "rejected",
    statusPagamento: "rejected", detalhePagamento: "rejected"
  }, cobrancaBase);
  assert.equal(recusado.situacao, "recusada");
});

test("agendamento com cobranca PIX nao pode receber segunda aprovacao manual", () => {
  assert.equal(pagamentoPixConfirmadoManualmente({ pixCobrancaId: cobrancaBase.id }), true);
  assert.equal(pagamentoPixConfirmadoManualmente({ status: "agendado" }), false);
});

test("tela de confirmacao recebe valores reais somente com pagamento e Firestore confirmados", async () => {
  const req = { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ reservaId: "b52cf512-e0c4-4d71-b3ca-0ef72b0b42bc" })); } };
  const pool = { query: async () => ({ rows: [{
    estado_cobranca: "paga", agendamento_id: "pix-appointment-1", estado_reserva: "confirmada",
    valor_total_centavos: "3000", valor_sinal_centavos: "2000", valor_restante_centavos: "1000"
  }] }) };
  const firestore = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({
    clienteId: "cliente-1", nomeCliente: "Ana Lima", servico: "Manicure", data: "2026-10-15", horario: "10:00", status: "confirmado"
  }) }) }) }) };
  let response;
  const res = { writeHead(status) { this.status = status; }, end(body) { response = JSON.parse(body); } };
  await atenderConfirmacaoAgendamentoPix(req, res, pool, { verificarUsuario: async () => "cliente-1", firestore });
  assert.equal(res.status, 200);
  assert.equal(response.agendamentoConfirmado, true);
  assert.equal(response.valorTotalCentavos, 3000);
  assert.equal(response.sinalPagoCentavos, 2000);
  assert.equal(response.valorRestanteCentavos, 1000);
});

test("sinal fixo por servico calcula valor e restante em centavos", () => {
  const campos = criarCamposSinalServico(50, "fixo", "15.00");
  assert.deepEqual(campos, {
    pixSinalTipo: "fixo",
    pixSinalValorCentavos: 1500,
    pixSinalPercentual: null,
  });
  assert.deepEqual(calcularSinalServico({ preco: 50, ...campos }), {
    valorTotalCentavos: 5000,
    tipoSinal: "fixo",
    percentualSinal: null,
    valorFixoConfiguradoCentavos: 1500,
    valorSinalCentavos: 1500,
    valorRestanteCentavos: 3500,
  });
});

test("sinal percentual por servico calcula a porcentagem sobre o preco", () => {
  const campos = criarCamposSinalServico(150, "percentual", "30");
  const valores = calcularSinalServico({ preco: 150, ...campos });
  assert.equal(valores.valorSinalCentavos, 4500);
  assert.equal(valores.valorRestanteCentavos, 10500);
  assert.equal(valores.percentualSinal, 30);
});

test("sinal percentual arredonda meio centavo para cima", () => {
  const valores = calcularSinalServico({
    preco: 1.01,
    pixSinalTipo: "percentual",
    pixSinalPercentual: 50,
  });
  assert.equal(valores.valorSinalCentavos, 51);
  assert.equal(valores.valorRestanteCentavos, 50);
});

test("servico sem sinal configurado nao recorre ao padrao global", () => {
  assert.throws(
    () => calcularSinalServico({ preco: 50 }),
    /Sinal PIX nao configurado/
  );
  assert.deepEqual(criarCamposSinalServico(50, "", ""), {
    pixSinalTipo: null,
    pixSinalValorCentavos: null,
    pixSinalPercentual: null,
  });
  assert.throws(() => calcularSinalServico({}), /Preco do servico invalido/);
});

test("sinal fixo superior ao preco e percentual acima de 100 sao rejeitados", () => {
  assert.throws(
    () => criarCamposSinalServico(50, "fixo", "50.01"),
    /nao superar o preco/
  );
  assert.throws(
    () => criarCamposSinalServico(50, "percentual", "100.01"),
    /no maximo 100/
  );
});

test("edicao recarrega a regra e preservar cobranca existente nao muda seu snapshot", () => {
  const servico = {
    preco: 50,
    pixSinalTipo: "fixo",
    pixSinalValorCentavos: 1500,
    pixSinalPercentual: null,
  };
  assert.deepEqual(obterEntradaSinalServico(servico), { tipo: "fixo", valor: "15.00" });

  const cobranca = Object.freeze({
    valor_total_centavos: 5000,
    valor_sinal_centavos: 1500,
    valor_restante_centavos: 3500,
    tipo_sinal: "fixo",
    valor_fixo_configurado_centavos: 1500,
  });
  const novaRegra = criarCamposSinalServico(60, "percentual", "25");
  assert.equal(calcularSinalServico({ preco: 60, ...novaRegra }).valorSinalCentavos, 1500);
  assert.deepEqual(cobranca, {
    valor_total_centavos: 5000,
    valor_sinal_centavos: 1500,
    valor_restante_centavos: 3500,
    tipo_sinal: "fixo",
    valor_fixo_configurado_centavos: 1500,
  });
});

test("cotacao e reserva dependem do mesmo calculador de sinal por servico", async () => {
  const [cotacao, reservas, admin] = await Promise.all([
    readFile(new URL("../src/pixCotacao.js", import.meta.url), "utf8"),
    readFile(new URL("../src/pixReservas.js", import.meta.url), "utf8"),
    readFile(new URL("../../../admin-servicos.js", import.meta.url), "utf8"),
  ]);
  assert.match(cotacao, /calcularSinalServico\(dadosServico\)/);
  assert.match(reservas, /calcularSinalServico\(servico\)/);
  assert.match(reservas, /valorSinalCentavos/);
  assert.match(reservas, /valorFixoConfiguradoCentavos/);
  assert.match(admin, /obterEntradaSinalServico/);
  assert.match(admin, /obterEntradaSinalServico\(servico\.dadosOriginais\)/);
  assert.match(admin, /pixSinalTipo/);
  assert.doesNotMatch(cotacao, /tipo_sinal_padrao|percentual_padrao|valor_fixo_padrao_centavos/);
  assert.doesNotMatch(reservas, /tipo_sinal_padrao|percentual_padrao|valor_fixo_padrao_centavos/);
  assert.match(reservas, /valores\.valorTotalCentavos,[\s\S]*valores\.percentualSinal,[\s\S]*valores\.valorSinalCentavos,[\s\S]*valores\.valorRestanteCentavos/);
  assert.match(reservas, /valores\.tipoSinal,[\s\S]*valores\.valorFixoConfiguradoCentavos/);
});

test("checkout consulta sinal antes de criar reserva PIX", async () => {
  const [checkout, cotacao, html] = await Promise.all([
    readFile(new URL("../../../pixCheckout.js", import.meta.url), "utf8"),
    readFile(new URL("../src/pixCotacao.js", import.meta.url), "utf8"),
    readFile(new URL("../../../agendamento.html", import.meta.url), "utf8"),
  ]);

  // A consulta de valores não pode gerar cobranças nem bloquear intervalos.
  assert.match(cotacao, /calcularSinalServico\(dadosServico\)/);
  assert.doesNotMatch(cotacao, /\b(?:INSERT INTO|UPDATE public|DELETE FROM)\b/i);
  assert.match(checkout, /postApi\("\/pix\/cotacao",\s*\{/);
  assert.match(checkout, /if \(!reservaAtual && !prosseguirPagamento\)/);
  assert.match(checkout, /btnProsseguirPix\.addEventListener\("click",/);
  assert.match(checkout, /prosseguirPagamento:\s*true/);

  const trechoCheckout = checkout.slice(checkout.indexOf("async function iniciarCheckout"));
  assert.ok(
    trechoCheckout.indexOf('postApi("/pix/cotacao"') <
      trechoCheckout.indexOf('postApi("/pix/reservar"'),
    "A cotação deve acontecer antes de qualquer tentativa de reserva",
  );
  assert.match(trechoCheckout, /if \(!reservaAtual && !prosseguirPagamento\)\s*\{[\s\S]*?apresentarCotacao\(cotacao, dados\);\s*return;/);
  assert.match(trechoCheckout, /cotacaoAtual\.servicoId !== dados\.servicoId/);
  assert.match(trechoCheckout, /caixaCotacao\.hidden = true;[\s\S]*?postApi\("\/pix\/reservar"/);
  assert.match(checkout, /getApi\("\/agendamentos\/isencao"\)/);
  assert.match(checkout, /postApi\("\/agendamentos\/sem-pix"/);
  assert.match(html, /pixCheckout\.js\?v=1\.0\.2/);
});
