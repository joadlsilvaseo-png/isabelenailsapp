import assert from "node:assert/strict";
import { analisarLacunasDoDia } from "../src/assistenteEncaixesGrade.mjs";

const data = "2026-11-06";
const manicurias = [
  { id: "remocao", nome: "Remoção de Gel", duracaoMinutos: 30 },
  { id: "manicure", nome: "Manicure", duracaoMinutos: 45 },
  { id: "fibra", nome: "Manutenção de Fibra", duracaoMinutos: 60 },
];
const servicoLongo = [{ id: "longo", nome: "Atendimento longo", duracaoMinutos: 90 }];
const analisarGap = (duracao, servicos = manicurias, extras = {}) => analisarLacunasDoDia({
  data,
  agendamentos: [{ inicioMinuto: 600, fimMinuto: 720 }, { inicioMinuto: 720 + duracao, fimMinuto: 900 + duracao }],
  reservas: [], bloqueios: [], servicos, hoje: "2026-11-05", ...extras,
});

const quinzeSemServico = analisarGap(15, manicurias.filter((s) => s.duracaoMinutos > 15));
assert.equal(quinzeSemServico.length, 1);
assert.equal(quinzeSemServico[0].classificacao, "sugestao_bloqueio");
assert.match(quinzeSemServico[0].justificativa, /15 minutos/);
assert.equal(analisarGap(15, [{ id: "x", nome: "Mini", duracaoMinutos: 15 }]).length, 0);

const trinta = analisarGap(30, [manicurias[0]]);
assert.equal(trinta.length, 1, "30 min sempre gera sugestão, mesmo com serviço curto elegível");
assert.equal(trinta[0].contemServicoBaixaProcura, true);
assert.match(trinta[0].justificativa, /baixa procura/);

assert.equal(analisarGap(45, [manicurias[0]]).length, 1, "45 min com apenas baixa procura sugere avaliação");
assert.equal(analisarGap(45, [manicurias[1]]).length, 0, "45 min com serviço normal elegível não sugere bloqueio");
assert.equal(analisarGap(45, [manicurias[2]]).length, 1, "45 min sem serviço elegível sugere avaliação");
assert.equal(analisarGap(60, [manicurias[2]]).length, 0, "60 min com serviço elegível não sugere bloqueio");
assert.equal(analisarGap(60, [servicoLongo]).length, 1, "60 min sem serviço elegível sugere avaliação");

const parcialHoje = analisarLacunasDoDia({
  data,
  agendamentos: [{ inicioMinuto: 600, fimMinuto: 720 }, { inicioMinuto: 810, fimMinuto: 900 }],
  servicos: [{ id: "noventa", nome: "Serviço de 90 min", duracaoMinutos: 90 }],
  hoje: data, agora: new Date("2026-11-06T15:17:00Z"), // 12:17 em São Paulo
});
assert.equal(parcialHoje[0]?.inicio, "12:30", "usa somente o restante futuro da lacuna de hoje");
assert.equal(parcialHoje[0]?.duracaoLacunaMinutos, 60);

// Reservas PIX pendentes, confirmadas e bloqueios são limites de lacuna.
const doisPeriodos = [{ inicioMinuto: 600, fimMinuto: 720 }, { inicioMinuto: 810, fimMinuto: 900 }];
assert.equal(analisarLacunasDoDia({ data, agendamentos: doisPeriodos, reservas: [{ inicioMinuto: 720, fimMinuto: 750 }], servicos: servicoLongo, hoje: "2026-11-05" })[0].inicio, "12:30");
assert.equal(analisarLacunasDoDia({ data, agendamentos: doisPeriodos, bloqueios: [{ inicioMinuto: 720, fimMinuto: 750 }], servicos: servicoLongo, hoje: "2026-11-05" })[0].inicio, "12:30");
assert.equal(analisarLacunasDoDia({ data, agendamentos: [doisPeriodos[0]], servicos: manicurias, hoje: "2026-11-05" }).length, 0,
  "não analisa lacunas de borda sem dois períodos ocupados");

assert.equal(analisarLacunasDoDia({
  data, agendamentos: doisPeriodos, reservas: [], bloqueios: [], servicos: manicurias,
  hoje: data, agora: new Date("2026-11-06T18:00:00Z"),
}).length, 0, "não alerta sobre horário já passado em São Paulo");
assert.deepEqual(analisarLacunasDoDia({
  data: "2026-11-08", agendamentos: doisPeriodos, servicos: manicurias, hoje: "2026-11-05",
}), [], "respeita calendário de expediente");

// Quarta possui pausa entre 12:30 e 14:00; não sugerir bloqueio que
// invada o horário fechado nem misturar manhã e tarde.
assert.deepEqual(analisarLacunasDoDia({
  data: "2026-11-11",
  agendamentos: [
    { inicioMinuto: 690, fimMinuto: 735 }, // 11:30–12:15
    { inicioMinuto: 855, fimMinuto: 915 }, // 14:15–15:15
  ],
  servicos: servicoLongo,
  hoje: "2026-11-06",
}), [], "não alerta sobre a pausa do expediente");
assert.equal(analisarLacunasDoDia({
  data: "2026-11-11",
  agendamentos: [
    { inicioMinuto: 600, fimMinuto: 630 }, // 10:00–10:30
    { inicioMinuto: 660, fimMinuto: 720 }, // 11:00–12:00
  ],
  servicos: servicoLongo,
  hoje: "2026-11-06",
}).length, 1, "lacuna dentro da mesma janela continua gerando sugestão");

const servicosDezembro = [
  { id: "ped", nome: "Pedicure Simples", categoria: "Pedicure", duracaoMinutos: 60 },
  { id: "man", nome: "Manicure Simples", categoria: "Manicure", duracaoMinutos: 60 },
];
assert.equal(analisarLacunasDoDia({
  data: "2026-12-18", agendamentos: [{ inicioMinuto: 540, fimMinuto: 600 }, { inicioMinuto: 660, fimMinuto: 720 }],
  servicos: servicosDezembro, hoje: "2026-11-06",
}).length, 0, "serviço normal autorizado em dezembro deixa a lacuna aproveitável");

assert.throws(() => analisarLacunasDoDia({ data, agendamentos: [{ inicioMinuto: 600, fimMinuto: 1500 }], servicos: manicurias }), /Intervalo inválido/);

// A passagem do relógio muda o trecho ainda disponível, não a identidade
// física da lacuna; evitar novos pushes a cada 15 minutos.
const lacunaHoje = {
  data,
  agendamentos: [{ inicioMinuto: 600, fimMinuto: 720 }, { inicioMinuto: 810, fimMinuto: 900 }],
  servicos: [{ id: "long", nome: "Procedimento longo", duracaoMinutos: 90 }],
  hoje: data,
};
const amostras = ["15:17:00Z", "15:32:00Z", "15:47:00Z"].map((hora) => {
  const itens = analisarLacunasDoDia({
    ...lacunaHoje, agora: new Date(`2026-11-06T${hora}`),
  });
  assert.equal(itens.length, 1);
  return itens[0];
});
assert.deepEqual(amostras.map((item) => item.inicio), ["12:30", "12:45", "13:00"]);
assert.deepEqual(amostras.map((item) => item.duracaoLacunaMinutos), [60, 45, 30]);
assert.deepEqual(amostras.map((item) => item.chave), Array(3).fill("2026-11-06:720:810"),
  "a mesma lacuna não deve gerar novas identidades durante a passagem do tempo");

console.log("Assistente de Agenda: classificação preventiva e regras de lacunas aprovadas");
