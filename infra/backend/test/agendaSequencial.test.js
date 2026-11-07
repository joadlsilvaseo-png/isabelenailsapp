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
test("Firestore: proteger início após cliente diferente e permitir sequência da mesma cliente", async () => {
  const db = firestore([primeiro]);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, "cliente-1", db)).ocupado, false);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, "cliente-2", db)).ocupado, true);
  assert.equal((await verificarConflitoFirestore(data, 1005, 1125, "cliente-1", db)).ocupado, true);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, null, db)).ocupado, true);
  assert.equal((await verificarConflitoFirestore(data, 1020, 1140, "cliente-1",
    firestore([{ ...primeiro, status: "agendado" }]))).ocupado, true);
});
test("lock por data: reserva confirmada mesma cliente libera sequência; demais aguardam 15 min", async () => {
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
  assert.equal(await verificarEncaixeNoBanco({ ...args, clienteUid: "cliente-2" }), false);
  assert.equal(await verificarEncaixeNoBanco({ ...args, inicio: 1005, fim: 1125 }), false);
  linhas = [{ ...linhas[0], agendamento_id: null }];
  assert.equal(await verificarEncaixeNoBanco(args), false, "sem ID de agendamento confirmado, não há isenção de proteção");
  linhas = [{ ...linhas[0], estado: "reservada" }];
  assert.equal(await verificarEncaixeNoBanco(args), false, "reserva ainda pendente não autoriza sequência");
  linhas = [{ inicio_minuto: 1020, fim_minuto: 1035, tipo: "bloqueio" }];
  assert.equal(await verificarEncaixeNoBanco(args), false);
});

test("lock protege reserva pendente no último minuto, sem bloquear término anterior", async () => {
  const db = firestore([]);
  const row = { inicio_minuto: 960, fim_minuto: 1020, tipo: "reserva",
    estado: "reservada", cliente_uid: "cliente-1", agendamento_id: null };
  const conexao = { query: async () => ({ rows: [row] }) };
  const base = { conexao, db, data, clienteUid: "cliente-1" };
  assert.equal(await verificarEncaixeNoBanco({ ...base, inicio: 1020, fim: 1080 }), false);
  assert.equal(await verificarEncaixeNoBanco({ ...base, inicio: 1035, fim: 1095 }), true);
  assert.equal(await verificarEncaixeNoBanco({ ...base, inicio: 900, fim: 960 }), true);
});
