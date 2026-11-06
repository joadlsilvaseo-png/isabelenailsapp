import assert from "node:assert/strict";
import { verificarEncaixeNoBanco } from "../src/pixEncaixes.js";
import { indisponivelComBuffer } from "../src/agendaBuffer.mjs";

const base = { data: "2026-12-18", inicio: 1020, fim: 1140 };
const funcionarioBloqueia = { inicio_minuto: 1020, fim_minuto: 1035, tipo: "bloqueio", cliente_uid: null };

function simular({ reservas = [], docs = [] } = {}) {
  const sql = [];
  return {
    conexao: { async query(texto, args) {
      sql.push({ texto, args });
      assert.match(texto, /cliente_uid/);
      assert.match(texto, /estado IN \\('reservada', 'confirmada'\\)/);
      return { rows: reservas };
    } },
    db: { collection(nome) {
      assert.equal(nome, "agendamentos");
      return { where(nomeCampo, condicao, data) {
        assert.deepEqual([nomeCampo, condicao, data], ["data", "==", "2026-12-18"]);
        return { get: async () => ({ docs: docs.map((item, i) => ({
          id: String(i), data: () => item,
        })) }) };
      } };
    } },
    sql,
  };
}

const propria = {
  inicio_minuto: 960, fim_minuto: 1020, tipo: "reserva", cliente_uid: "uid-A",
};
const ocupadaPorOutra = { ...propria, cliente_uid: "uid-B" };
const mesmoFirestore = { status: "confirmado", clienteId: "uid-A", horario: "16:00", duracao: 60 };
const outroFirestore = { ...mesmoFirestore, clienteId: "uid-B" };

for (const cenario of [
  { nome: "reserva PIX pendente da própria cliente", reservas: [propria], uid: "uid-A", esperado: true },
  { nome: "reserva de outra cliente", reservas: [ocupadaPorOutra], uid: "uid-A", esperado: false },
  { nome: "Firestore da própria cliente", docs: [mesmoFirestore], uid: "uid-A", esperado: true },
  { nome: "Firestore de outra cliente", docs: [outroFirestore], uid: "uid-A", esperado: false },
  { nome: "cliente própria e outra reserva adjacente", reservas: [propria, ocupadaPorOutra], uid: "uid-A", esperado: false },
  { nome: "bloqueio da profissional", reservas: [propria, funcionarioBloqueia], uid: "uid-A", esperado: false },
  { nome: "sem UID não dispensa buffer", reservas: [propria], uid: null, esperado: false },
]) {
  const { conexao, db } = simular(cenario);
  const resultado = await verificarEncaixeNoBanco({
    conexao, db, ...base, clienteUid: cenario.uid,
  });
  assert.equal(resultado, cenario.esperado, cenario.nome);
}

const { conexao, db } = simular({reservas:[propria],docs:[mesmoFirestore]});
assert.equal(await verificarEncaixeNoBanco({
  conexao,db,...base,clienteUid:"uid-A",inicio:1015,
}),false,"sobreposição nunca é permitida");
assert.equal(await verificarEncaixeNoBanco({
  conexao,db,...base,clienteUid:"uid-A",inicio:1025,
}),false,"intervalo de 5 minutos não é consecutivo");
assert.equal(await verificarEncaixeNoBanco({
  conexao,db,...base,clienteUid:"uid-A",inicio:1035,
}),true,"após os 15 minutos funciona normalmente");

assert.equal(indisponivelComBuffer(1020,1140,[
  { inicioMinuto:960,fimMinuto:1020,tipo:"reserva",mesmaCliente:true },
  { inicioMinuto:960,fimMinuto:1020,tipo:"agendamento",mesmaCliente:true },
]),false,"as duas fontes do mesmo atendimento não bloqueiam erroneamente a sequência");
console.log("Mesma cliente: PostgreSQL e Firestore revalidados sem sobreposição");
