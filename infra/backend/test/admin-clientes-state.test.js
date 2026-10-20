import test from "node:test";
import assert from "node:assert/strict";
import { salvarIsencaoComReversao } from "../../../admin-clientes-state.js";

test("controle de isenção conserva o estado após confirmação do servidor", async () => {
  const states = [];
  const feedback = [];
  const result = await salvarIsencaoComReversao({
    uid: "cliente-1", ativa: true,
    salvar: async (uid, ativa) => ({ clienteUid: uid, ativa }),
    aplicarEstado: (value) => states.push(value),
    informar: (message, state) => feedback.push({ message, state }),
  });
  assert.equal(result, true);
  assert.deepEqual(states, []);
  assert.deepEqual(feedback, [{ message: "Autorização ativa.", state: "success" }]);
});

test("falha de rede ou confirmação divergente reverte o controle visual", async () => {
  for (const salvar of [
    async () => { throw new Error("API indisponível"); },
    async () => ({ clienteUid: "outra-cliente", ativa: true }),
  ]) {
    const states = [];
    const feedback = [];
    const result = await salvarIsencaoComReversao({
      uid: "cliente-1", ativa: true, salvar,
      aplicarEstado: (value) => states.push(value),
      informar: (message, state) => feedback.push({ message, state }),
    });
    assert.equal(result, false);
    assert.deepEqual(states, [false]);
    assert.equal(feedback[0].state, "error");
    assert.match(feedback[0].message, /revertido/);
  }
});
