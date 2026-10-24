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



// Simula transações concorrentes com semântica de lock por data.
// A operação concorrente não pode sequer consultar/gravar até a primeira
// transação concluir. A simulação não acessa PostgreSQL nem Firestore reais.
function simularConcorrenciaCalendario() {
  let travado = false;
  const fila = [];
  const reservas = [];
  const bloqueios = [];
  let numeroCliente = 0;
  let sinalPrimeiro;
  let soltarPrimeiro;
  const primeiroAdquiriu = new Promise((resolve) => { sinalPrimeiro = resolve; });
  const liberarPrimeiro = new Promise((resolve) => { soltarPrimeiro = resolve; });
  const eventos = [];
  function liberarLock() {
    const proximo = fila.shift();
    if (proximo) proximo();
    else travado = false;
  }
  const pool = {
    async connect() {
      const indice = ++numeroCliente;
      const pendentes = { reservas: [], bloqueios: [] };
      let adquiriuLock = false;
      return {
        async query(sql, params = []) {
          if (sql === "BEGIN") return { rows: [], rowCount: 0 };
          if (sql.includes("pg_advisory_xact_lock")) {
            if (travado) await new Promise((resolve) => fila.push(resolve));
            else travado = true;
            adquiriuLock = true;
            eventos.push("lock-" + indice);
            if (indice === 1) {
              sinalPrimeiro();
              await liberarPrimeiro;
            }
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("SELECT 1 FROM public.agenda_bloqueios")) {
            const [, inicio, fim] = params;
            const encontrados = bloqueios.filter((item) =>
              sobrepoe(inicio, fim, item.inicio, item.fim));
            return { rows: encontrados, rowCount: encontrados.length };
          }
          if (sql.includes("FROM public.pix_reservas")) {
            const encontrados = reservas.map(({ inicio, fim }) => ({
              inicio_minuto: inicio, fim_minuto: fim,
            }));
            return { rows: encontrados, rowCount: encontrados.length };
          }
          if (sql.includes("INSERT INTO public.agenda_bloqueios")) {
            pendentes.bloqueios.push({ inicio: params[1], fim: params[2] });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("INSERT INTO public.pix_reservas")) {
            pendentes.reservas.push({ inicio: params[1], fim: params[2] });
            return { rows: [], rowCount: 1 };
          }
          if (sql === "COMMIT" || sql === "ROLLBACK") {
            if (sql === "COMMIT") {
              bloqueios.push(...pendentes.bloqueios);
              reservas.push(...pendentes.reservas);
            }
            if (adquiriuLock) {
              eventos.push(sql.toLowerCase() + "-" + indice);
              liberarLock();
              adquiriuLock = false;
            }
            return { rows: [], rowCount: 0 };
          }
          throw Error("SQL desconhecido no teste concorrente: " + sql);
        },
        release() {},
      };
    },
  };
  // Reproduz o trecho transacional utilizado pelas reservas PIX: BEGIN,
  // advisory lock do dia, consulta de bloqueio e gravação/COMMIT ou ROLLBACK.
  async function reservar(inicio, fim) {
    const conexao = await pool.connect();
    try {
      await conexao.query("BEGIN");
      await conexao.query(
        "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
        [DATA],
      );
      if (await possuiBloqueio(conexao, DATA, inicio, fim)) {
        throw new Error("Agenda fechada pela profissional neste horário");
      }
      await conexao.query(
        "INSERT INTO public.pix_reservas (data_servico, inicio_minuto, fim_minuto) VALUES ($1, $2, $3)",
        [DATA, inicio, fim],
      );
      await conexao.query("COMMIT");
    } catch (erro) {
      await conexao.query("ROLLBACK");
      throw erro;
    } finally { conexao.release(); }
  }
  const fechar = () => alterarHorarios({
    pool, db: criarDb(), uid: "admin-1", data: DATA,
    horas: [900, 930], acao: "fechar", agora: FIXO,
  });
  return {
    primeiroAdquiriu,
    liberarPrimeiro: () => soltarPrimeiro(),
    eventos, reservas, bloqueios, fechar, reservar,
  };
}

for (const primeiro of ["reserva", "fechamento"]) {
  test("corrida reserva x fechamento — " + primeiro + " obtém lock primeiro", async () => {
    const sim = simularConcorrenciaCalendario();
    const operacaoReserva = () => sim.reservar(870, 990); // 14h30–16h30.
    const operacaoFechar = () => sim.fechar(); // 15h–16h.
    const primeiroProcesso = primeiro === "reserva" ? operacaoReserva() : operacaoFechar();
    await sim.primeiroAdquiriu;
    const segundoProcesso = primeiro === "reserva" ? operacaoFechar() : operacaoReserva();
    let segundoFinalizou = false;
    // Impede rejeição não tratada durante a simulação.
    const segundoObservado = segundoProcesso.then(
      () => { segundoFinalizou = true; },
      () => { segundoFinalizou = true; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(segundoFinalizou, false, "segundo processo precisa aguardar lock");
    sim.liberarPrimeiro();
    const resultados = await Promise.allSettled([primeiroProcesso, segundoProcesso]);
    await segundoObservado;
    assert.deepEqual(resultados.map(({ status }) => status), ["fulfilled", "rejected"]);
    assert.equal(sim.eventos[0], "lock-1");
    assert.ok(sim.eventos.indexOf("commit-1") < sim.eventos.indexOf("lock-2"));
    if (primeiro === "reserva") {
      assert.equal(sim.reservas.length, 1);
      assert.equal(sim.bloqueios.length, 0, "admin não pode sobrescrever reserva PIX ativa");
      assert.equal(resultados[1].reason.status, 409);
    } else {
      assert.equal(sim.reservas.length, 0, "PIX não pode reservar sobre agenda fechada");
      assert.equal(sim.bloqueios.length, 2);
      assert.match(resultados[1].reason.message, /Agenda fechada/);
    }
  });
}

// Guarda de regressão: o simulador acima espelha o caminho real. Verifica
// estaticamente que os três fluxos continuam tomando o mesmo lock ANTES
// de consultar agenda_bloqueios, dentro de BEGIN/COMMIT.
test("PIX, isenção e reagendamento compartilham chave e ordem do lock", async () => {
  const { readFileSync } = await import("node:fs");
  for (const nome of ["pixReservas.js", "agendamentosIsencaoPix.js"]) {
    const codigo = readFileSync(new URL("../src/" + nome, import.meta.url), "utf8");
    const trechos = nome === "pixReservas.js"
      ? [codigo.slice(codigo.indexOf('await conexao.query("BEGIN")'))]
      : [
          codigo.slice(codigo.indexOf("export async function criarAgendamentoIsento"),
            codigo.indexOf("export async function reagendarComBloqueio")),
          codigo.slice(codigo.indexOf("export async function reagendarComBloqueio")),
        ];
    for (const trecho of trechos) {
      const inicio = trecho.indexOf('await conexao.query("BEGIN")');
      const lock = trecho.indexOf("pg_advisory_xact_lock(hashtext('isabele_pix_agenda')");
      const consulta = trecho.indexOf("await possuiBloqueio(conexao, data, periodo.inicioMinuto, periodo.fimMinuto)");
      const commit = trecho.indexOf('await conexao.query("COMMIT")');
      assert.ok(inicio >= 0 && inicio < lock && lock < consulta && consulta < commit,
        nome + ": bloqueio deve preceder consulta e gravação na transação");
    }
  }
});
