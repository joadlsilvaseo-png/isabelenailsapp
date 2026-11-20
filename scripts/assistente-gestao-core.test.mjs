import test from "node:test";
import assert from "node:assert/strict";
import { montarVisaoGestao, minutosLivresRestantes, linkWhatsApp, mensagemRetorno, adicionarDiasISO, diferencaDiasISO } from "../assistenteGestaoCore.mjs";

const hoje = "2026-11-07";
const base = { janelas: [{ inicioMinuto: 540, encerramentoMinuto: 1080 }], hoje, horarioAtual: "09:00", intervalosPix: [] };
const ag = (id, clienteId, data, horario, duracao, status, servico = "Manicure", extra = {}) =>
  ({ id, clienteId, data, horario, duracao, status, servico, ...extra });

test("resumo contabiliza atendimentos ativos e concluídos sem somar cancelados", () => {
  const dados = montarVisaoGestao({ ...base, clientes: [], agendamentos: [
    ag("a", "1", hoje, "09:00", 60, "confirmado"),
    ag("b", "2", hoje, "10:00", 45, "concluido"),
    ag("c", "3", hoje, "11:00", 60, "cancelado_cliente"),
  ]});
  assert.equal(dados.resumo.atendimentos, 2);
  assert.equal(dados.resumo.duracaoReservada, 105);
  assert.equal(dados.resumo.tempoLivreRestante, 540 - 105);
  assert.equal(dados.resumo.proximo.horario, "09:00");
});

test("tempo livre não duplica bloqueios PIX, e falha de API não inventa horários", () => {
  const p = { janelas: [{ inicioMinuto: 540, encerramentoMinuto: 780 }], agoraMinuto: 540,
    ocupacoes: [{ inicioMinuto: 540, fimMinuto: 600 }],
    intervalosPix: [{ inicioMinuto: 570, fimMinuto: 630 }, { inicioMinuto: 690, fimMinuto: 720 }] };
  assert.equal(minutosLivresRestantes(p), 120);
  assert.equal(minutosLivresRestantes({ ...p, intervalosPix: null }), null);
  assert.equal(minutosLivresRestantes({ ...p, agoraMinuto: 720 }), 60);
});

test("radar usa 21 dias para aplicação de gel concluída e sem agenda futura", () => {
  const visitas = [
    ag("a", "gel", "2026-10-17", "10:00", 60, "concluido", "Alongamento de unhas em gel"),
    ag("b", "outro", "2026-10-17", "11:00", 60, "concluido", "Alongamento de unhas em gel"),
    ag("c", "outro", "2026-11-10", "14:00", 60, "confirmado", "Manutenção"),
    ag("d", "somente", "2026-10-17", "14:00", 60, "concluido", "Manicure"),
  ];
  const d = montarVisaoGestao({ ...base, agendamentos: visitas,
    clientes: [{ id: "gel", nome: "Ana Silva", telefone: "11999999999" }] });
  assert.equal(d.radar.length, 1);
  assert.equal(d.radar[0].nome, "Ana Silva");
  assert.equal(d.radar[0].diasParaRetorno, 0);
  assert.equal(d.recomendacoes[0].tipo, "retorno");
});

test("radar infere recorrência de duas visitas e ignora cancelamento ou histórico remoto", () => {
  const d = montarVisaoGestao({ ...base, clientes: [], agendamentos: [
    ag("a", "x", "2026-09-26", "10:00", 45, "realizado"),
    ag("b", "x", "2026-10-17", "10:00", 45, "realizado"),
    ag("c", "y", "2026-03-03", "10:00", 45, "concluido", "Alongamento de unhas em gel"),
  ]});
  assert.equal(d.radar.length, 1);
  assert.equal(d.radar[0].uid, "x");
  assert.equal(d.radar[0].dataSugerida, hoje);
  assert.equal(adicionarDiasISO("2026-10-17", 21), hoje);
  assert.equal(diferencaDiasISO("2026-10-17", hoje), 21);
});

test("análise semanal compara terça a sábado com semana anterior completa, sem chamar receita recebida", () => {
  const d = montarVisaoGestao({ ...base, clientes: [], agendamentos: [
    ag("a", "1", "2026-11-05", "10:00", 45, "realizado", "Manicure", { precoSnapshot: 70 }),
    ag("b", "2", "2026-10-31", "10:00", 45, "realizado", "Manicure", { precoSnapshot: 70 }),
    ag("c", "3", "2026-10-30", "10:00", 45, "realizado", "Manicure", { precoSnapshot: 60 }),
    ag("d", "4", "2026-10-31", "11:00", 45, "cancelado_cliente", "Manicure"),
  ]});
  assert.equal(d.semana.atual.concluidos, 1);
  assert.equal(d.semana.anterior.concluidos, 2);
  assert.equal(d.semana.atualInicio, "2026-11-03");
  assert.equal(d.semana.atualFim, "2026-11-07");
  assert.equal(d.semana.anteriorInicio, "2026-10-27");
  assert.equal(d.semana.anteriorFim, "2026-10-31");
  assert.equal(d.semana.atual.receitaEstimada, 70);
  assert.equal(d.semana.atual.maisFrequente, "Manicure");
  assert.equal(d.recomendacoes[0].tipo, "semanal");
});

test("mensagem WhatsApp requer revisão e só gera link para número válido", () => {
  const msg = mensagemRetorno({ nome: "Ana Silva", criterio: "Manutenção sugerida após aplicação de gel" });
  assert.match(msg, /Ana/);
  assert.match(msg, /manutenção/);
  assert.ok(linkWhatsApp("(11) 99999-9999", msg)?.startsWith("https://wa.me/5511999999999?text="));
  assert.equal(linkWhatsApp("sem telefone", msg), null);
});

test("radar reinicia 21 dias após manutenções e mantém o bloqueio por agendamento futuro", () => {
  const visitas = [
    ag("g1", "gel", "2026-10-17", "10:00", 90, "concluido", "Alongamento em gel"),
    ag("g2", "gel", "2026-11-04", "10:00", 90, "realizado", "Manutenção em Gel"),
    ag("g3", "gel", "2026-11-08", "10:00", 45, "realizado", "Manicure Simples"),
    ag("s1", "somente", "2026-11-04", "14:00", 60, "concluido", "Manutenção de Fibra"),
    ag("a1", "agendada", "2026-11-04", "10:00", 60, "concluido", "Manutenção em Gel"),
    ag("a2", "agendada", "2026-11-25", "10:00", 60, "confirmado", "Manutenção em Gel"),
    ag("r1", "remocao", "2026-11-04", "10:00", 60, "concluido", "Aplicação de Gel"),
    ag("r2", "remocao", "2026-11-18", "10:00", 45, "concluido", "Remoção de Alongamento", { categoria: "Unhas em Gel" }),
  ];
  const d = montarVisaoGestao({ ...base, hoje: "2026-11-20", agendamentos: visitas, clientes: [] });
  assert.equal(d.radar.length, 2);
  const gel = d.radar.find((x) => x.uid === "gel");
  assert.equal(gel.dataSugerida, "2026-11-25");
  assert.equal(gel.ultimaVisita, "2026-11-04");
  assert.equal(gel.criterio, "Manutenção sugerida após manutenção de gel");
  assert.ok(d.radar.some((x) => x.uid === "somente"));
  assert.ok(!d.radar.some((x) => x.uid === "agendada"));
  assert.ok(!d.radar.some((x) => x.uid === "remocao"));
  assert.match(mensagemRetorno(gel), /sua próxima manutenção/);
});

test("meta semanal compara 7 concluídos até quinta com 15 da semana passada completa", () => {
  const previa = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"];
  const corrente = ["2026-11-17", "2026-11-18", "2026-11-19"];
  const agendamentos = [
    ...Array.from({ length: 15 }, (_, i) =>
      ag("p" + i, "p" + i, previa[i % previa.length], "09:00", 45, "concluido")),
    ...Array.from({ length: 7 }, (_, i) =>
      ag("a" + i, "a" + i, corrente[i % corrente.length], "09:00", 45, "realizado")),
    ag("domingo", "d", "2026-11-15", "09:00", 45, "realizado"),
    ag("segunda", "s", "2026-11-16", "09:00", 45, "concluido"),
    ag("futuro", "f", "2026-11-20", "09:00", 45, "concluido"),
    ag("marcado", "m", "2026-11-19", "10:00", 45, "confirmado"),
    ag("cancelado", "c", "2026-11-19", "10:00", 45, "cancelado_cliente"),
  ];
  const d = montarVisaoGestao({
    ...base, hoje: "2026-11-19", clientes: [], agendamentos,
  });
  assert.equal(d.semana.atual.concluidos, 7);
  assert.equal(d.semana.anterior.concluidos, 15);
  assert.equal(d.semana.atualInicio, "2026-11-17");
  assert.equal(d.semana.atualFim, "2026-11-19");
  assert.equal(d.semana.anteriorInicio, "2026-11-10");
  assert.equal(d.semana.anteriorFim, "2026-11-14");
  assert.equal(d.semana.atual.cancelados, 1);
  assert.equal(d.recomendacoes.find((x) => x.tipo === "semanal")?.descricao.includes("Faltam 8"), true);
});

test("domingo e segunda preservam semana terça-sábado; terça reinicia a meta", () => {
  const agendamentos = [
    ag("a", "1", "2026-11-17", "09:00", 45, "concluido"),
    ag("b", "2", "2026-11-21", "09:00", 45, "concluido"),
    ag("c", "3", "2026-11-22", "09:00", 45, "concluido"),
    ag("d", "4", "2026-11-23", "09:00", 45, "concluido"),
    ag("e", "5", "2026-11-24", "09:00", 45, "concluido"),
  ];
  for (const hojeTeste of ["2026-11-22", "2026-11-23"]) {
    const d = montarVisaoGestao({ ...base, hoje: hojeTeste, clientes: [], agendamentos });
    assert.equal(d.semana.atualInicio, "2026-11-17");
    assert.equal(d.semana.atualFim, "2026-11-21");
    assert.equal(d.semana.atual.concluidos, 2);
  }
  const terca = montarVisaoGestao({ ...base, hoje: "2026-11-24", clientes: [], agendamentos });
  assert.equal(terca.semana.atualInicio, "2026-11-24");
  assert.equal(terca.semana.atualFim, "2026-11-24");
  assert.equal(terca.semana.anterior.concluidos, 2);
  assert.equal(terca.semana.atual.concluidos, 1);
});

test("limites de semana atravessam o ano sem perder a terça-feira", () => {
  const d = montarVisaoGestao({ ...base, hoje: "2027-01-01", clientes: [], agendamentos: [] });
  assert.equal(d.semana.atualInicio, "2026-12-29");
  assert.equal(d.semana.atualFim, "2027-01-01");
  assert.equal(d.semana.anteriorInicio, "2026-12-22");
  assert.equal(d.semana.anteriorFim, "2026-12-26");
});
