import assert from "node:assert/strict";
import { descreverNovasOportunidades, varrerOportunidades } from "../src/assistenteEncaixesMonitor.js";
import { criarNotificacaoPreventiva } from "../src/assistenteEncaixesNotificacao.mjs";

const dados = [
  { chave: "2026-11-07:720:750", data: "2026-11-07", inicio: "12:00", fim: "12:30", duracaoLacunaMinutos: 30, classificacao: "sugestao_bloqueio", justificativa: "Intervalo curto", opcoes: [] },
];
assert.deepEqual(descreverNovasOportunidades([], dados), dados);
assert.deepEqual(descreverNovasOportunidades([dados[0].chave], dados), []);
assert.throws(() => descreverNovasOportunidades(null, []), /inválido/);
assert.match(criarNotificacaoPreventiva("2026-11-07", [{
  ...dados[0], contemServicoBaixaProcura: true,
  servicosElegiveis: [{ id: "remo", nome: "Remoção de Gel", duracaoMinutos: 30 }],
}]).mensagem, /utilizável.*baixa procura.*Remoção de Gel/);
assert.match(criarNotificacaoPreventiva("2026-11-07", [{
  ...dados[0], duracaoLacunaMinutos: 45, contemServicoBaixaProcura: true,
  servicosElegiveis: [{ id: "remo", nome: "Remoção de Gel", duracaoMinutos: 30 }],
}]).mensagem, /pode receber.*Remoção de Gel/);

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
  const estado = { valor: null, notificacoes: [], cancelamentos: 0 };
  const con = {
    async query(sql, args = []) {
      if (sql.includes("SELECT valor FROM public.push_controle")) return { rowCount: estado.valor === null ? 0 : 1, rows: [{ valor: estado.valor }] };
      if (sql.includes("INSERT INTO public.push_controle")) estado.valor = args[1];
      if (sql.includes("UPDATE public.push_controle")) estado.valor = args[1];
      if (sql.includes("INSERT INTO public.push_entregas")) estado.notificacoes.push({ sql, args });
      if (sql.includes("UPDATE public.push_entregas") && sql.includes("sugestao_bloqueio_agenda")) {
        const atuais = new Set(args[0] || []);
        for (const item of estado.notificacoes) {
          if (!item.cancelada && !atuais.has(item.args[0])) { item.cancelada = true; estado.cancelamentos++; }
        }
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { connect: async () => con, estado };
}
const pool = mockPool();
const db = mockDb();
const agora = new Date("2026-11-06T12:00:00Z");
let resultados = [];
const consultar = async ({ agora: passado }) => { assert.equal(passado, agora); return resultados; };

const primeiro = await varrerOportunidades({ pool, db, agora, consultar });
assert.equal(primeiro.inicializado, true);
assert.equal(pool.estado.notificacoes.length, 0, "inicialização silenciosa não deve gerar alertas retroativos");
assert.equal((await varrerOportunidades({ pool, db, agora, consultar })).novas, 0);

resultados = [...dados, { ...dados[0], chave: "2026-11-07:750:780", inicio: "12:30", fim: "13:00" }];
const nova = await varrerOportunidades({ pool, db, agora, consultar });
assert.equal(nova.novas, 2);
assert.equal(pool.estado.notificacoes.length, 1, "duas sugestões no mesmo dia são agrupadas num push");
const entrega = pool.estado.notificacoes[0];
assert.match(entrega.sql, /'sugestao_bloqueio_agenda'/);
assert.match(entrega.args[0], /^assistente-agenda-v1:2026-11-07:uid-admin:[a-f0-9]{24}$/);
assert.equal(entrega.args[5], "./admin-calendario.html?data=2026-11-07");
assert.match(entrega.args[4], /2 intervalos/);
assert.equal((await varrerOportunidades({ pool, db, agora, consultar })).novas, 0);
assert.equal(pool.estado.notificacoes.length, 1, "a chave estável evita duplicação em varreduras repetidas");

resultados = resultados.map((item) => item.chave === dados[0].chave
  ? { ...item, inicio: "12:15", duracaoLacunaMinutos: 15, classificacao: "sugestao_bloqueio" }
  : item);
assert.equal((await varrerOportunidades({ pool, db, agora, consultar })).novas, 0,
  "a passagem do tempo não cria uma nova identidade para a mesma lacuna");
assert.equal(pool.estado.notificacoes.length, 1);

resultados = [dados[0]];
await varrerOportunidades({ pool, db, agora, consultar });
assert.equal(pool.estado.cancelamentos, 1, "recomendações pendentes antigas são descartadas após mudança da agenda");

console.log("Assistente: janela de sete dias, agrupamento, deduplicação e limpeza aprovados");
