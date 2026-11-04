import { readFile } from "node:fs/promises";
import { atenderAgendamentoIsencao } from "../src/agendamentosIsencaoPix.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  pixPagoReagendamentoHabilitado,
  validarPagamentoPixReagendamento,
  montarPayloadReagendamentoPix,
  enviarReagendamentoPix,
} from "../src/pixReagendamentoPago.js";

const appt = "agendamento-1";
const charge = "11111111-1111-4111-8111-111111111111";
const uid = "cliente-fixture";
const servicoId = "manicure";
const evento = "evt_agendamento-1";
const operacao = "22222222-2222-4222-8222-222222222222";
const gas = "https://script.google.com/macros/s/TESTE_ISABELE_123/exec";
const entrada = {
  agendamento: { clienteId: uid, idServico: servicoId, pixCobrancaId: charge, pixStatusFinanceiro: "pago" },
  reserva: {
    cliente_uid: uid, cobranca_cliente_uid: uid, agendamento_id: appt, cobranca_agendamento_id: appt,
    estado: "confirmada", cobranca_estado: "paga", cobranca_id: charge, servico_id: servicoId,
  },
  servicoId, agendamentoId: appt,
};

test("PIX pago é rejeitado quando feature está explicitamente desabilitada", () => {
  assert.equal(pixPagoReagendamentoHabilitado({ pixPagoReagendamentoHabilitado: false }), false);
});

test("PIX pago exige vínculo confirmado entre reserva, cobrança e agendamento", () => {
  assert.deepEqual(validarPagamentoPixReagendamento(entrada), { valido: true });
});

for (const [campo, valor, mensagem] of [
  ["cobranca_estado", "pendente", "cobrança não paga"],
  ["cobranca_estado", "estornada", "cobrança estornada"],
  ["estado", "reservada", "reserva ainda pendente"],
  ["cobranca_id", "outro", "reserva de outra cobrança"],
  ["cobranca_cliente_uid", "outro", "cobrança de outra cliente"],
  ["agendamento_id", "outro", "reserva de outro agendamento"],
  ["servico_id", "outro", "mudança de serviço sem autorização"],
]) {
  test("PIX pago bloqueia " + mensagem, () => {
    assert.equal(validarPagamentoPixReagendamento({
      ...entrada, reserva: { ...entrada.reserva, [campo]: valor },
    }).valido, false);
  });
}

test("PIX pago impede troca de serviço e mantém sinal original", () => {
  assert.equal(validarPagamentoPixReagendamento({ ...entrada, servicoId: "outra-manicure" }).valido, false);
});

test("PIX estornado no Firestore é recusado mesmo se cobrança divergir", () => {
  assert.equal(validarPagamentoPixReagendamento({
    ...entrada, agendamento: { ...entrada.agendamento, pixStatusFinanceiro: "estornado" },
  }).valido, false);
});

test("payload REAGENDAR mantém o mesmo eventId e não contém cobrança PIX", () => {
  const payload = montarPayloadReagendamentoPix({
    eventId: evento, operationId: operacao, data: "2026-11-12", horario: "14:30",
    duracao: 60, nomeCliente: "Cliente Teste", servico: "Manicure",
  });
  assert.equal(payload.acao, "REAGENDAR");
  assert.equal(payload.eventId, evento);
  assert.equal(payload.dataInicio, "2026-11-12T14:30:00");
  assert.equal(payload.duracaoMinutos, 60);
  assert.equal("pixCobrancaId" in payload, false);
  assert.equal("criarCobranca" in payload, false);
});

test("GAS deve responder explicitamente JSON confirmando o mesmo evento", async () => {
  const payload = montarPayloadReagendamentoPix({
    eventId: evento, operationId: operacao, data: "2026-11-12", horario: "14:30",
    duracao: 60, nomeCliente: "Cliente Teste", servico: "Manicure",
  });
  let destino = null;
  const r = await enviarReagendamentoPix(payload, async (url) => {
    destino = url;
    return { ok: true, async text() { return JSON.stringify({ ok: true, reagendado: true, eventId: evento }); } };
  }, gas);
  assert.equal(destino, gas);
  assert.equal(r.eventId, evento);
});

test("implantação PIX confirma REAGENDAR com status REAGENDADO e mesmo eventId", async () => {
  const payload = montarPayloadReagendamentoPix({
    eventId: evento, operationId: operacao, data: "2027-03-10", horario: "04:00",
    duracao: 30, nomeCliente: "CLIENTE FICTICIA", servico: "TESTE TECNICO",
  });
  const resultado = await enviarReagendamentoPix(payload,
    async () => ({
      ok: true,
      async text() {
        return JSON.stringify({ ok: true, status: "REAGENDADO", eventId: evento });
      },
    }), gas,
  );
  assert.equal(resultado.status, "REAGENDADO");
  assert.equal(resultado.eventId, payload.eventId);
});

test("resposta REAGENDADO sem identidade válida é rejeitada", async () => {
  const payload = montarPayloadReagendamentoPix({
    eventId: evento, operationId: operacao, data: "2027-03-10", horario: "04:00",
    duracao: 30, nomeCliente: "CLIENTE FICTICIA", servico: "TESTE TECNICO",
  });
  for (const resultado of [
    { ok: true, status: "REAGENDADO" },
    { ok: true, status: "REAGENDADO", eventId: "evt_diferente" },
    { ok: false, status: "REAGENDADO", eventId: evento },
    { ok: true, status: "CANCELADO", eventId: evento },
    { ok: true, status: "AGENDADO", eventId: evento },
  ]) {
    await assert.rejects(enviarReagendamentoPix(payload,
      async () => ({ ok: true, async text() { return JSON.stringify(resultado); } }),
      gas,
    ), /não confirmou alteração do mesmo evento/);
  }
});

test("GAS devolvendo texto legado, sucesso ambíguo ou id diferente é recusado", async () => {
  const payload = montarPayloadReagendamentoPix({
    eventId: evento, operationId: operacao, data: "2026-11-12", horario: "14:30",
    duracao: 60, nomeCliente: "Cliente Teste", servico: "Manicure",
  });
  for (const body of ["REAGENDADO COM SUCESSO", '{"ok":true}', JSON.stringify({ ok: true, reagendado: true, eventId: "outro" })]) {
    await assert.rejects(enviarReagendamentoPix(payload,
      async () => ({ ok: true, async text() { return body; } }), gas));
  }
});

test("sem URL validada, nem tenta conexão externa com Calendar", async () => {
  let chamado = false;
  const payload = montarPayloadReagendamentoPix({
    eventId: evento, operationId: operacao, data: "2026-11-12", horario: "14:30",
    duracao: 60, nomeCliente: "Cliente Teste", servico: "Manicure",
  });
  await assert.rejects(enviarReagendamentoPix(payload, async () => { chamado = true; }, ""));
  assert.equal(chamado, false);
});

test("configuração de reagendamento PIX nunca habilita a operação sem saga completa", async () => {
  const resp = { status: null, body: null, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const pool = { query: async () => { throw new Error("Não deveria consultar PostgreSQL"); } };
  await atenderAgendamentoIsencao(
    { method: "GET", url: "/agendamentos/reagendar/config" }, resp, pool,
    { firestore: {}, verificarUsuario: async () => uid },
  );
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.body, { pixPagoHabilitado: false });
});

test("servidor encaminha consulta do estado de reagendamento à rota correta", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /"\/agendamentos\/reagendar\/config"/);
});
