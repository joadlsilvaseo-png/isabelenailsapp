import assert from "node:assert/strict";
import { processarEntrega } from "../src/pushWorker.js";

const updates = [];
const pool = { query: async (sql, params) => { updates.push({ sql, params }); return { rowCount: 1 }; } };
let enviados = 0;
const entrega = {
  id: 41,
  tipo: "sugestao_bloqueio_agenda",
  destino: "./admin-calendario.html?data=2026-11-07",
  chave_evento: "assistente-agenda-v1:2026-11-07:admin:abc",
};

const cancelada = await processarEntrega(pool, entrega, {
  validarSugestao: async (_pool, item) => item.destino.includes("2026-11-07") && false,
  enviar: async () => { enviados++; return "enviado"; },
});
assert.equal(cancelada, "cancelado");
assert.equal(enviados, 0, "recomendação obsoleta não é enviada");
assert.deepEqual(updates.at(-1).params, [41, "cancelado"]);

const antiga = await processarEntrega(pool, { ...entrega, id: 42, tipo: "oportunidade_encaixe" }, {
  enviar: async () => { enviados++; return "enviado"; },
});
assert.equal(antiga, "cancelado");
assert.equal(enviados, 0, "entregas pendentes do assistente anterior não são enviadas após a troca");

const valida = await processarEntrega(pool, { ...entrega, id: 43 }, {
  validarSugestao: async () => true,
  enviar: async () => { enviados++; return "enviado"; },
});
assert.equal(valida, "enviado");
assert.equal(enviados, 1);
console.log("Assistente: push cancela sugestões obsoletas antes de enviar");
