import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { obterIdConsultaDisponibilidadePix } from "../agendamentoPixConsulta.mjs";
import { consultarDisponibilidadePix } from "../agendamentosApi.js";

test("reagendamento com PIX cobrado mantém a reserva original na projeção de leitura", () => {
  assert.equal(obterIdConsultaDisponibilidadePix("ag-1", {
    pixCobrancaId: "cobranca-paga", status: "confirmado",
  }), null);
});

test("reagendamento com PIX pago legado também consulta sem exclusão", () => {
  assert.equal(obterIdConsultaDisponibilidadePix("ag-1", {
    pixPagamentoId: "pagamento-pago", status: "reagendado",
  }), null);
});

test("reagendamento isento continua enviando ID original e mantendo regra atual", () => {
  assert.equal(obterIdConsultaDisponibilidadePix("ag-isento", {
    sinalPixIsento: true, status: "confirmado",
  }), "ag-isento");
});

test("novo agendamento e ausência de documento não geram exclusão arbitrária", () => {
  assert.equal(obterIdConsultaDisponibilidadePix(null, null), null);
  assert.equal(obterIdConsultaDisponibilidadePix("ag-inexistente", null), null);
});

test("consulta de reagendamento PIX pago não envia agendamentoId e conserva a reserva retornada", async () => {
  const fetchOriginal = globalThis.fetch;
  const requisicoes = [];
  const reservaOriginal = { inicioMinuto: 600, fimMinuto: 690, tipo: "reserva" };
  globalThis.fetch = async (url, init) => {
    requisicoes.push({ url: String(url), init });
    return { ok: true, json: async () => ({ intervalos: [reservaOriginal] }) };
  };
  try {
    const idConsulta = obterIdConsultaDisponibilidadePix("ag-1", { pixCobrancaId: "pix-1" });
    const intervalos = await consultarDisponibilidadePix({
      currentUser: { getIdToken: async () => "token-de-teste" },
    }, "2026-12-04", idConsulta);
    assert.deepEqual(intervalos, [reservaOriginal], "horário original continua reservado");
    assert.equal(requisicoes.length, 1);
    assert.equal(requisicoes[0].url, "/api/pix/disponibilidade?data=2026-12-04");
    assert.equal(requisicoes[0].init.headers.Authorization, "Bearer token-de-teste");
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("consulta de reagendamento sem PIX segue enviando agendamentoId para exclusão autorizada", async () => {
  const fetchOriginal = globalThis.fetch;
  const requisicoes = [];
  globalThis.fetch = async (url) => {
    requisicoes.push(String(url));
    return { ok: true, json: async () => ({ intervalos: [] }) };
  };
  try {
    const idConsulta = obterIdConsultaDisponibilidadePix("ag-isento", { sinalPixIsento: true });
    await consultarDisponibilidadePix({
      currentUser: { getIdToken: async () => "token-de-teste" },
    }, "2026-12-04", idConsulta);
    assert.equal(requisicoes[0], "/api/pix/disponibilidade?data=2026-12-04&agendamentoId=ag-isento");
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test("três caminhos de atualização da agenda usam o mesmo ID de leitura", async () => {
  const js = await readFile(new URL("../agendamento.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../agendamento.html", import.meta.url), "utf8");
  const api = await readFile(new URL("../infra/backend/src/pixDisponibilidadeApi.js", import.meta.url), "utf8");
  assert.match(js, /const idConsultaPix = obterIdConsultaDisponibilidadePix\(reagendarId, agendamentoOriginal\)/);
  assert.match(js, /consultarDisponibilidadePix\(auth, String\(dataIso\)\.trim\(\), idConsultaPix\)/);
  assert.equal((js.match(/renderizarHorarios\(dataIso, serviceDuration, reagendarId, serviceInfo, idConsultaPix\)/g) || []).length, 2);
  assert.match(js, /renderizarHorarios\(dataAtiva, serviceDuration, reagendarId, serviceInfo, idConsultaPix\)/);
  assert.match(js, /reagendarAgendamentoApi\(auth, \{/);
  assert.match(html, /agendamento\.js\?v=2\.11\.0/);
  assert.match(api, /if \(dados\.pixCobrancaId \|\| dados\.pixPagamentoId\) return \{ ok: false, status: 409 \};/,
    "proteção do backend não deve ser removida");
});
