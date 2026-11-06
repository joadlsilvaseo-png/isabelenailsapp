import assert from "node:assert/strict";
import { consultarMesEncaixes } from "../src/assistenteEncaixes.js";

const data = "2026-11-12"; // quinta-feira
const agendamentos = [
  { id: "a", data: { data, horario: "11:00", duracao: 60, status: "confirmado" } },
  { id: "b", data: { data, horario: "13:30", duracao: 60, status: "confirmado" } },
];
function firestore() {
  return { collection(nome) {
    if (nome === "servicos") return { get: async () => ({ docs: [
      { id: "servico90", data: () => ({ nome: "Alongamento", ativo: true, duracao: 90 }) },
    ] }) };
    assert.equal(nome, "agendamentos");
    return { where(campo, op) {
      assert.equal(campo, "data");
      assert.ok([">=", "<"].includes(op));
      return { where(c2, op2) {
        assert.deepEqual([c2, op2], ["data", "<"]);
        return { get: async () => ({
          docs: agendamentos.map(({ id, data: d }) => ({ id, data: () => d })),
        }) };
      } };
    } };
  } };
}
function postgres(rows) {
  return { async query(sql, parametros) {
    assert.match(sql, /FROM public.pix_reservas/);
    assert.match(sql, /FROM public.agenda_bloqueios/);
    assert.deepEqual(parametros, ["2026-11-01", "2026-12-01"]);
    return { rows };
  } };
}
const agora = new Date("2026-11-06T12:00:00Z");
const duplicada = {
  data, inicio_minuto: 660, fim_minuto: 720, tipo: "reserva",
  estado: "confirmada", agendamento_id: "a",
};
const ok = await consultarMesEncaixes({
  db: firestore(), pool: postgres([duplicada]), mes: "2026-11", agora,
});
assert.equal(ok.length, 1);
assert.equal(ok[0].inicio, "12:00");
assert.ok(ok[0].opcoes.some(x => x.duracaoMinutos === 90));

const pendente = await consultarMesEncaixes({
  db: firestore(), pool: postgres([{
    ...duplicada, agendamento_id: "a", inicio_minuto: 720, fim_minuto: 810,
  }]), mes: "2026-11", agora,
});
assert.equal(pendente.length, 0, "reserva não sincronizada bloqueia o período");

const bloqueado = await consultarMesEncaixes({
  db: firestore(), pool: postgres([{
    data, inicio_minuto: 720, fim_minuto: 810, tipo: "bloqueio",
    estado: null, agendamento_id: null,
  }]), mes: "2026-11", agora,
});
assert.equal(bloqueado.length, 0);
console.log("Assistente: Firestore/PG, reserva antiga e bloqueio validados");
