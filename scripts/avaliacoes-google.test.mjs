import test from "node:test";
import assert from "node:assert/strict";
import { ehAtendimentoConcluido, clienteTemAtendimentoConcluido } from "../avaliacoesGoogle.mjs";

test("somente status concluído ou realizado habilitam o convite", () => {
  for (const status of ["concluido", "realizado", " Concluído ", "REALIZADO"])
    assert.equal(ehAtendimentoConcluido({ status }), true, status);
  for (const status of ["agendado", "confirmado", "reagendado", "cancelado_cliente", "cancelado_profissional", ""])
    assert.equal(ehAtendimentoConcluido({ status }), false, status);
});

test("cliente atendida tem acesso imediato, inclusive via idCliente legado", () => {
  assert.equal(clienteTemAtendimentoConcluido([
    { clienteId: "ana", status: "confirmado" },
    { clienteId: "ana", status: "concluido" },
  ], "ana"), true);
  assert.equal(clienteTemAtendimentoConcluido([
    { idCliente: "ana", status: "realizado" },
  ], "ana"), true);
  assert.equal(clienteTemAtendimentoConcluido([
    { data: () => ({ clienteId: "ana", status: "concluido" }) },
  ], "ana"), true);
});

test("sem histórico, só agendado ou outra conta não autoriza convite", () => {
  assert.equal(clienteTemAtendimentoConcluido([], "ana"), false);
  assert.equal(clienteTemAtendimentoConcluido([
    { clienteId: "ana", status: "agendado" },
    { clienteId: "ana", status: "cancelado_profissional" },
    { clienteId: "beatriz", status: "concluido" },
  ], "ana"), false);
  assert.equal(clienteTemAtendimentoConcluido([
    { clienteId: "beatriz", status: "concluido" },
  ], ""), false);
});
