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

test("radar usa 21 dias somente para aplicação de gel concluída e sem agenda futura", () => {
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

test("análise semanal compara intervalos de sete dias equivalentes, sem chamar receita recebida", () => {
  const d = montarVisaoGestao({ ...base, clientes: [], agendamentos: [
    ag("a", "1", "2026-11-05", "10:00", 45, "realizado", "Manicure", { precoSnapshot: 70 }),
    ag("b", "2", "2026-10-31", "10:00", 45, "realizado", "Manicure", { precoSnapshot: 70 }),
    ag("c", "3", "2026-10-30", "10:00", 45, "realizado", "Manicure", { precoSnapshot: 60 }),
    ag("d", "4", "2026-11-01", "11:00", 45, "cancelado_cliente", "Manicure"),
  ]});
  assert.equal(d.semana.atual.concluidos, 1);
  assert.equal(d.semana.anterior.concluidos, 2);
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
