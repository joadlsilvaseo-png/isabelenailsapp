import test from "node:test";
import assert from "node:assert/strict";

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
import { ambienteMercadoPagoAtual, criarPedidoPix, mercadoPagoHabilitado, montarPedidoPix } from "../src/pixMercadoPago.js";
import { identificarNotificacoesAgendamento } from "../src/agendaNotificacoes.js";
import { processarOrderNotificada } from "../src/pixWebhookWorker.js";
import { processarProximaNotificacaoPix } from "../src/pixWebhookFila.js";
import { pagamentoPixConfirmadoManualmente } from "../src/pixRegrasConfirmacao.js";
import { atenderConfirmacaoAgendamentoPix } from "../src/pixAgendamentoConfirmacao.js";

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
    process.env.PIX_TEST_ORDERS_ENABLED = "true";
    assert.equal(ambienteMercadoPagoAtual(), "test");
    assert.equal(mercadoPagoHabilitado("test"), true);
    assert.equal(mercadoPagoHabilitado("production"), false);
    process.env.PIX_PRODUCTION_ORDERS_ENABLED = "true";
    assert.equal(mercadoPagoHabilitado("production"), false, "produção exige token e segredo do webhook");
    const dados = { valorCentavos: 2000, referenciaExterna: "isabele_pix_123", chaveIdempotencia: "6d8f562d-5e85-4bc8-9705-932158e7c2a9", emailPagador: "cliente@example.com" };
    assert.equal(montarPedidoPix({ ...dados, ambiente: "test" }).payer.first_name, "APRO");
    assert.equal("first_name" in montarPedidoPix({ ...dados, ambiente: "production" }).payer, false);
    process.env.MP_ENVIRONMENT = "production";
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
  assert.deepEqual(resultado, { concluido: true });
  assert.equal(creditos, 1);
  assert.equal(efetivacoes, 1);
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
