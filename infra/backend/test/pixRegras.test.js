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

  return {
    dados,
    eventos,
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
            snapshot = structuredClone(dados);
            return { rows: [] };
          }
          if (normalizado === "commit") {
            liberar?.();
            return { rows: [] };
          }
          if (normalizado === "rollback") {
            if (snapshot) {
              dados.charge = snapshot.charge;
              dados.reservation = snapshot.reservation;
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
