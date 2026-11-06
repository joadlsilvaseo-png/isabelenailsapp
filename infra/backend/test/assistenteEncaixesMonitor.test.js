import assert from "node:assert/strict";
import { descreverNovasOportunidades, varrerOportunidades } from "../src/assistenteEncaixesMonitor.js";

const dados = [
  { chave: "2026-12-10:720:810", data: "2026-12-10", inicio: "12:00", fim: "13:30", duracaoLacunaMinutos: 90, opcoes: [] },
];
assert.deepEqual(descreverNovasOportunidades([], dados), dados);
assert.deepEqual(descreverNovasOportunidades([dados[0].chave], dados), []);
assert.throws(() => descreverNovasOportunidades(null, []), /inválido/);

function mockDb() {
  return { collection(nome) {
    assert.equal(nome, "usuarios");
    return { where(campo, op, valor) {
      assert.deepEqual([campo, op, valor], ["role", "==", "admin"]);
      return { get: async () => ({ docs: [{ id: "uid-admin", data: () => ({ ativo: true }) }] }) };
    } };
  } };
}
function mockPool() {
  const estado = { valor: null, notificacoes: [] };
  const con = {
    async query(sql, args = []) {
      if (sql.includes("SELECT valor FROM public.push_controle")) {
        return { rowCount: estado.valor === null ? 0 : 1, rows: [{ valor: estado.valor }] };
      }
      if (sql.includes("INSERT INTO public.push_controle")) estado.valor = args[1];
      if (sql.includes("UPDATE public.push_controle")) estado.valor = args[1];
      if (sql.includes("INSERT INTO public.push_entregas")) estado.notificacoes.push(args);
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { connect: async () => con, estado };
}
const pool = mockPool();
const db = mockDb();
const agora = new Date("2026-11-06T12:00:00Z");
let resultados = dados;
const consultar = async ({ mes }) => mes === "2026-12" ? resultados : [];
const primeiro = await varrerOportunidades({ pool, db, agora, consultar });
assert.equal(primeiro.inicializado, true);
assert.equal(pool.estado.notificacoes.length, 0);
assert.equal((await varrerOportunidades({ pool, db, agora, consultar })).novas, 0);
resultados = [...dados, {
  ...dados[0], chave: "2026-12-11:750:810", data: "2026-12-11", inicio: "12:30",
}];
assert.equal((await varrerOportunidades({ pool, db, agora, consultar })).novas, 1);
assert.equal(pool.estado.notificacoes.length, 1);
assert.equal((await varrerOportunidades({ pool, db, agora, consultar })).novas, 0);
const entradaNovoMes = {
  chave: "2027-02-11:720:810", data: "2027-02-11",
  inicio: "12:00", fim: "13:30", duracaoLacunaMinutos: 90, opcoes: [],
};
let oportunidadesFevereiro = [entradaNovoMes];
const consultarNovoMes = async ({ mes }) => {
  if (mes === "2026-12") return resultados;
  if (mes === "2027-02") return oportunidadesFevereiro;
  return [];
};
const dezembro = new Date("2026-12-01T12:00:00Z");
const primeiroNovoMes = await varrerOportunidades({
  pool, db, agora: dezembro, consultar: consultarNovoMes,
});
assert.equal(primeiroNovoMes.novas, 0, "mês recém-vigiado não pode disparar alertas antigos");
assert.equal(pool.estado.notificacoes.length, 1);
oportunidadesFevereiro = [...oportunidadesFevereiro, {
  ...entradaNovoMes, chave: "2027-02-12:720:810", data: "2027-02-12",
}];
assert.equal((await varrerOportunidades({
  pool, db, agora: dezembro, consultar: consultarNovoMes,
})).novas, 1);
assert.equal(pool.estado.notificacoes.length, 2);

console.log("Assistente: deduplicação, virada de mês e primeiro ciclo silencioso aprovados");
