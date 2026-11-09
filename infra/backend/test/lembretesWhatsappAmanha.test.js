import test from "node:test";
import assert from "node:assert/strict";
import {
  amanhaSaoPaulo, normalizarLembrete, normalizarTelefoneWhatsapp,
  resumoLembretes, validarMarcacao,
} from "../src/lembretesWhatsappAmanhaCore.mjs";
import { atenderLembretesWhatsappAmanha } from "../src/lembretesWhatsappAmanha.js";

const AGORA = new Date("2026-11-09T12:00:00.000Z");
const AMANHA = "2026-11-10";

function bancoFixture() {
  const documentos = {
    usuarios: { admin: { role: "admin", ativo: true }, cliente: { role: "cliente", ativo: true } },
    clientes: {
      c1: { nome: "Mariana Oliveira", telefone: "(11) 99999-0000" },
      c2: { nome: "Cliente Sem Telefone" },
    },
    agendamentos: {
      ag1: { clienteId: "c1", data: AMANHA, horario: "09:00", status: "confirmado",
        servico: "Banho de Gel", idServico: "s1", duracao: 90 },
      ag2: { clienteId: "c2", data: AMANHA, horario: "11:00", status: "agendado",
        servico: "Manicure", idServico: "s2" },
      ag3: { clienteId: "c1", data: AMANHA, horario: "15:00", status: "cancelado_profissional",
        servico: "Manicure" },
      ag4: { clienteId: "c1", data: "2026-11-11", horario: "08:00", status: "reagendado" },
    },
  };
  const snapshot = (id, item) => ({
    id, exists: item !== undefined, data: () => item === undefined ? undefined : structuredClone(item),
  });
  const db = {
    collection(name) {
      return {
        doc(id) {
          return { get: async () => snapshot(id, documentos[name]?.[id]) };
        },
        where(field, op, value) {
          assert.equal(op, "==");
          return {
            get: async () => ({
              docs: Object.entries(documentos[name] || {})
                .filter(([, dados]) => dados[field] === value)
                .map(([id, item]) => snapshot(id, item)),
            }),
          };
        },
      };
    },
  };
  const marcados = new Map();
  const queries = [];
  const pool = {
    async query(sql, valores) {
      queries.push(sql);
      if (sql.startsWith("SELECT agendamento_id")) {
        return { rows: [...marcados.values()].filter((r) => r.data_servico === valores[0] &&
          valores[1].includes(r.agendamento_id)) };
      }
      if (sql.startsWith("INSERT INTO public.lembretes")) {
        const [id, assinatura, data, adminUid] = valores;
        marcados.set(id + ":" + assinatura, {
          agendamento_id: id, assinatura, data_servico: data,
          marcado_em: "2026-11-09T13:10:00.000Z", admin: adminUid,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM public.lembretes")) {
        marcados.delete(valores[0] + ":" + valores[1]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error("SQL nao previsto: " + sql);
    },
  };
  return { db, documentos, pool, marcados, queries };
}
function requisicao(method = "GET", path = "/admin/lembretes-amanha", dados) {
  const req = { method, url: path };
  if (dados !== undefined) req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify(dados));
  };
  return req;
}
function resposta() {
  return {
    status: 0, dados: null, headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(texto) { this.dados = JSON.parse(texto); },
  };
}
async function executar({ db, pool, admin = "admin", method = "GET", path, body, agora = AGORA }) {
  const res = resposta();
  await atenderLembretesWhatsappAmanha(requisicao(method, path, body), res, pool, {
    firestore: db, now: agora, verificarUsuario: async () => admin,
  });
  return res;
}

test("calcula amanha no fuso de Sao Paulo antes e depois da meia-noite", () => {
  assert.equal(amanhaSaoPaulo(new Date("2026-11-09T02:30:00Z")), "2026-11-09");
  assert.equal(amanhaSaoPaulo(new Date("2026-11-09T03:30:00Z")), "2026-11-10");
});
test("normaliza telefones brasileiros e nao aceita numero invalido", () => {
  assert.equal(normalizarTelefoneWhatsapp("(11) 99999-0000"), "5511999990000");
  assert.equal(normalizarTelefoneWhatsapp("+55 (11) 99999-0000"), "5511999990000");
  assert.equal(normalizarTelefoneWhatsapp("123"), "");
});
test("assinatura muda com alteracao de horario, servico e telefone; cancelado desaparece", () => {
  const agendamento = { data: AMANHA, horario: "09:00", status: "confirmado",
    clienteId: "c1", servico: "Banho de Gel", idServico: "s1", duracao: 90 };
  const base = { id: "ag1", agendamento, data: AMANHA,
    cliente: { nome: "Mariana", telefone: "11999990000" } };
  const item = normalizarLembrete(base);
  assert.ok(item?.assinatura);
  assert.notEqual(item.assinatura, normalizarLembrete({
    ...base, agendamento: { ...agendamento, horario: "10:00" },
  }).assinatura);
  assert.notEqual(item.assinatura, normalizarLembrete({
    ...base, agendamento: { ...agendamento, servico: "Manicure" },
  }).assinatura);
  assert.notEqual(item.assinatura, normalizarLembrete({
    ...base, cliente: { nome: "Mariana", telefone: "11988880000" },
  }).assinatura);
  assert.equal(normalizarLembrete({
    ...base, agendamento: { ...agendamento, status: "cancelado_profissional" },
  }), null);
  assert.equal(normalizarLembrete({
    ...base, agendamento: { ...agendamento, data: "2026-11-11" },
  }), null);
});
test("contagem nao confunde sem telefone com lembrete pendente enviavel", () => {
  assert.deepEqual(resumoLembretes([
    { possuiTelefone: true, marcadoEnviado: false },
    { possuiTelefone: true, marcadoEnviado: true },
    { possuiTelefone: false, marcadoEnviado: false },
  ]), { total: 3, pendentes: 1, marcados: 1, semTelefone: 1 });
});
test("lista so atende admin ativo; não expoe dados de clientes para nao admin", async () => {
  const { db, pool, queries } = bancoFixture();
  const recusado = await executar({ db, pool, admin: "cliente" });
  assert.equal(recusado.status, 403);
  assert.equal(queries.length, 0);
  const aceito = await executar({ db, pool });
  assert.equal(aceito.status, 200);
  assert.equal(aceito.dados.data, AMANHA);
  assert.equal(aceito.dados.resumo.total, 2);
  assert.equal(aceito.dados.resumo.pendentes, 1);
  assert.equal(aceito.dados.resumo.semTelefone, 1);
  assert.equal(aceito.dados.itens[0].telefone, "5511999990000");
  assert.equal(aceito.headers["Cache-Control"], "no-store");
});
test("marcacao e desfazer sao idempotentes, sem enviar mensagens", async () => {
  const { db, pool, marcados } = bancoFixture();
  const inicial = await executar({ db, pool });
  const item = inicial.dados.itens[0];
  const body = { agendamentoId: item.agendamentoId, assinatura: item.assinatura };
  const url = "/admin/lembretes-amanha/marcacao";
  assert.equal((await executar({ db, pool, method: "POST", path: url, body })).status, 200);
  assert.equal((await executar({ db, pool, method: "POST", path: url, body })).status, 200);
  assert.equal(marcados.size, 1);
  const depois = await executar({ db, pool });
  assert.equal(depois.dados.resumo.marcados, 1);
  assert.equal(depois.dados.resumo.pendentes, 0);
  assert.equal((await executar({ db, pool, method: "DELETE", path: url, body })).status, 200);
  assert.equal(marcados.size, 0);
});
test("reagendamento invalida marcacao antiga; novo horario volta a pendente", async () => {
  const { db, pool, documentos } = bancoFixture();
  const inicio = (await executar({ db, pool })).dados.itens[0];
  const url = "/admin/lembretes-amanha/marcacao";
  const body = { agendamentoId: inicio.agendamentoId, assinatura: inicio.assinatura };
  await executar({ db, pool, method: "POST", path: url, body });
  documentos.agendamentos.ag1.horario = "10:30";
  const obsoleta = await executar({ db, pool, method: "POST", path: url, body });
  assert.equal(obsoleta.status, 409);
  const nova = await executar({ db, pool });
  assert.equal(nova.dados.resumo.pendentes, 1);
  assert.notEqual(nova.dados.itens[0].assinatura, inicio.assinatura);
  documentos.agendamentos.ag1.status = "cancelado_profissional";
  assert.equal((await executar({ db, pool })).dados.resumo.total, 1);
});
test("nao marca sem telefone nem aceita assinatura arbitraria", async () => {
  const { db, pool, marcados } = bancoFixture();
  const itens = (await executar({ db, pool })).dados.itens;
  const sem = itens.find((i) => !i.possuiTelefone);
  const url = "/admin/lembretes-amanha/marcacao";
  assert.equal((await executar({ db, pool, method: "POST", path: url,
    body: { agendamentoId: sem.agendamentoId, assinatura: sem.assinatura } })).status, 409);
  assert.equal((await executar({ db, pool, method: "POST", path: url,
    body: { agendamentoId: "ag1", assinatura: "erro" } })).status, 400);
  assert.equal(marcados.size, 0);
  assert.equal(validarMarcacao({ agendamentoId: "ag1", assinatura: "f".repeat(64) }), true);
});
