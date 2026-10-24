import test from "node:test";
import assert from "node:assert/strict";
import {
  sobrepoe, possuiBloqueio, alterarHorarios, atenderGerenciarCalendario,
  ErroCalendario,
} from "../src/agendaBloqueios.js";
import { listarSlotsGerenciaveis } from "../src/agendamentoRegras.mjs";

const FIXO = new Date("2026-10-24T12:00:00-03:00");
const DATA = "2026-11-05";
function criarDb(status = "admin", agendamentos = []) {
  return {
    collection(nome) {
      if (nome === "usuarios") return {
        doc() { return { async get() { return {
          exists: true, data() { return { role: status, ativo: true }; },
        }; } }; },
      };
      if (nome === "agendamentos") return {
        where(campo, op, data) {
          assert.equal(campo, "data");
          assert.equal(op, "==");
          assert.equal(data, DATA);
          return { async get() {
            return { docs: agendamentos.map((dados) => ({ data: () => dados })) };
          } };
        },
      };
      throw Error("coleção inesperada " + nome);
    },
  };
}
function criarPool({ reservas = [], bloqueios = [] } = {}) {
  const chamadas = [];
  const conexao = {
    async query(sql, params = []) {
      chamadas.push({ sql, params });
      if (/FROM public.pix_reservas/.test(sql)) {
        return { rows: reservas.map(({ inicio, fim }) => ({ inicio_minuto: inicio, fim_minuto: fim })), rowCount: reservas.length };
      }
      if (/FROM public.agenda_bloqueios/.test(sql) && /^\s*SELECT/i.test(sql)) {
        const [data, inicio, fim] = params;
        const filtradas = bloqueios.filter(({ inicio: a, fim: b }) =>
          params.length === 1 || sobrepoe(inicio, fim, a, b));
        return { rows: filtradas.map(({ inicio, fim }) => ({ inicio_minuto: inicio, fim_minuto: fim })), rowCount: filtradas.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { chamadas.push({ sql: "RELEASE" }); },
  };
  return { chamadas, conexao, connect: async () => conexao, query: conexao.query };
}
function criarResposta() {
  return { status: null, body: null, writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); } };
}

test("intervalos semifechados: 14h30–16h30 invade fechamento 15h–16h", () => {
  assert.equal(sobrepoe(870, 990, 900, 960), true);
  assert.equal(sobrepoe(870, 900, 900, 960), false);
  assert.equal(sobrepoe(960, 990, 900, 960), false);
});

test("slots administrativos seguem janela mensal e dezembro fechado", () => {
  assert.ok(listarSlotsGerenciaveis("2026-11-03", FIXO).includes(900));
  assert.equal(listarSlotsGerenciaveis("2026-11-03", FIXO).includes(540), false);
  assert.ok(listarSlotsGerenciaveis("2026-11-04", FIXO).includes(570)); // Fechar 09:30 afeta início 09h.
  assert.equal(listarSlotsGerenciaveis("2026-11-04", FIXO).includes(810), false); // Almoço.
  assert.deepEqual(listarSlotsGerenciaveis("2026-12-03", FIXO), []);
});

test("validação no banco usa sobreposição real e não igualdade de hora", async () => {
  const pool = criarPool({ bloqueios: [{ inicio: 900, fim: 930 }] });
  assert.equal(await possuiBloqueio(pool.conexao, DATA, 870, 990), true);
  assert.equal(await possuiBloqueio(pool.conexao, DATA, 930, 990), false);
  assert.match(pool.chamadas[0].sql, /int4range\(inicio_minuto, fim_minuto, '\[\)'\)/);
});

test("fechamento múltiplo usa lock por dia, não registra nada no Google Calendar", async () => {
  const pool = criarPool();
  const result = await alterarHorarios({
    pool, db: criarDb(), uid: "admin-1", data: DATA,
    horas: [900, 930, 960], acao: "fechar", agora: FIXO,
  });
  assert.equal(result.quantidade, 3);
  assert.ok(pool.chamadas.some(({ sql }) => sql.includes("pg_advisory_xact_lock")));
  assert.equal(pool.chamadas.filter(({ sql }) => sql.includes("INSERT INTO public.agenda_bloqueios")).length, 3);
  assert.ok(pool.chamadas.some(({ sql }) => sql === "COMMIT"));
  assert.equal(pool.chamadas.some(({ sql }) => /pix_calendar_outbox|Google|webhook|pix_cobrancas/i.test(sql)), false);
});

test("não fecha horário se existe reserva PIX sobreposta: transação inteira desfeita", async () => {
  const pool = criarPool({ reservas: [{ inicio: 870, fim: 990 }] });
  await assert.rejects(
    alterarHorarios({ pool, db: criarDb(), uid: "admin-1", data: DATA,
      horas: [900, 930], acao: "fechar", agora: FIXO }),
    (erro) => erro instanceof ErroCalendario && erro.status === 409,
  );
  assert.equal(pool.chamadas.some(({ sql }) => sql.includes("INSERT INTO public.agenda_bloqueios")), false);
  assert.ok(pool.chamadas.some(({ sql }) => sql === "ROLLBACK"));
});

test("reserva Firestore antiga também impede fechar horários em conflito", async () => {
  const pool = criarPool();
  await assert.rejects(
    alterarHorarios({ pool, db: criarDb("admin", [{ status: "confirmado", horario: "14:30", duracao: 120 }]),
      uid: "admin-1", data: DATA, horas: [900], acao: "fechar", agora: FIXO }),
    (erro) => erro.status === 409,
  );
  assert.ok(pool.chamadas.some(({ sql }) => sql === "ROLLBACK"));
});

test("reabrir remove só intervalos selecionados sem afetar reservas", async () => {
  const pool = criarPool();
  const resultado = await alterarHorarios({ pool, db: criarDb(), uid: "admin-1",
    data: DATA, horas: [900, 960], acao: "reabrir", agora: FIXO });
  assert.equal(resultado.acao, "reabrir");
  const deleteQuery = pool.chamadas.find(({ sql }) => sql.includes("DELETE FROM public.agenda_bloqueios"));
  assert.deepEqual(deleteQuery.params, [DATA, [900, 960]]);
});

test("clientes não conseguem consultar ou modificar o calendário administrativo", async () => {
  const pool = criarPool(), resposta = criarResposta();
  await atenderGerenciarCalendario(
    { method: "GET", url: "/admin/calendario?data=" + DATA }, resposta, pool,
    { verificarUsuario: async () => "cliente", firestore: criarDb("cliente"), now: FIXO },
  );
  assert.equal(resposta.status, 403);
  assert.equal(pool.chamadas.length, 0);
});

test("datas de dezembro e horários inválidos não são aceitos pelo servidor", async () => {
  const pool = criarPool();
  await assert.rejects(
    alterarHorarios({ pool, db: criarDb(), uid: "admin-1",
      data: "2026-12-03", horas: [900], acao: "fechar", agora: FIXO }),
    (erro) => erro.status === 400,
  );
  await assert.rejects(
    alterarHorarios({ pool, db: criarDb(), uid: "admin-1",
      data: DATA, horas: [900, 900], acao: "fechar", agora: FIXO }),
    (erro) => erro.status === 400,
  );
  assert.equal(pool.chamadas.length, 0);
});
