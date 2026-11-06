import test from "node:test";
import assert from "node:assert/strict";
import { verificarConflitoFirestore } from "../src/pixAgendaFirestore.js";
import { verificarEncaixeNoBanco } from "../src/pixEncaixes.js";

function firestore(documentos) {
  const docs = documentos.map((d, i) => ({ id: String(i), data: () => d }));
  return {
    collection: (nome) => {
      assert.equal(nome, "agendamentos");
      return { where: () => ({ get: async () => ({
        docs, forEach: (fn) => docs.forEach(fn),
      }) }) };
    },
  };
}
const data = "2026-12-18";
const primeiro = { data, clienteId: "cliente-1", status: "confirmado", horario: "16:00", duracao: 60 };
test("Firestore: qualquer cliente pode iniciar no término exato, sem permitir sobreposição", async () => {
  const db = firestore([primeiro]);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, "cliente-1", db)).ocupado, false);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, "cliente-2", db)).ocupado, false);
  assert.equal((await verificarConflitoFirestore(data, 1005, 1125, "cliente-1", db)).ocupado, true);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, null, db)).ocupado, false);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, "cliente-1",
    firestore([{ ...primeiro, status: "agendado" }]))).ocupado, false);
});
test("lock por data: reservas e documentos permitem sequência sem sobreposição", async () => {
  const db = firestore([primeiro]);
  let linhas = [{ inicio_minuto: 960, fim_minuto: 1020,
    tipo: "reserva", estado: "confirmada", cliente_uid: "cliente-1",
    agendamento_id: "primeiro-pago" }];
  const conexao = { query: async (sql) => {
    assert.match(sql, /FROM public.pix_reservas/);
    return { rows: linhas };
  } };
  const args = { conexao, db, data, inicio: 1020, fim: 1140, clienteUid: "cliente-1" };
  assert.equal(await verificarEncaixeNoBanco(args), true);
  assert.equal(await verificarEncaixeNoBanco({ ...args, clienteUid: "cliente-2" }), true);
  assert.equal(await verificarEncaixeNoBanco({ ...args, inicio: 1005, fim: 1125 }), false);
  linhas = [{ ...linhas[0], agendamento_id: null }];
  assert.equal(await verificarEncaixeNoBanco(args), true, "reserva adjacente não cria intervalo de buffer");
  linhas = [{ ...linhas[0], estado: "reservada" }];
  assert.equal(await verificarEncaixeNoBanco(args), true);
  linhas = [{ inicio_minuto: 1020, fim_minuto: 1035, tipo: "bloqueio" }];
  assert.equal(await verificarEncaixeNoBanco(args), false);
});
