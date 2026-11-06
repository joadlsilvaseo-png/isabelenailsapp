import assert from "node:assert/strict";
import { analisarLacunasDoDia } from "../src/assistenteEncaixesGrade.mjs";

const data = "2026-11-06"; // sexta, expediente contínuo
const servicos = [
  { id: "a", nome: "Manicure", duracaoMinutos: 30 },
  { id: "b", nome: "Gel", duracaoMinutos: 60 },
  { id: "c", nome: "Alongamento", duracaoMinutos: 90 },
  { id: "teste", nome: "Teste", duracaoMinutos: 15 },
];
const agendamentos = [
  { inicioMinuto: 600, fimMinuto: 720 }, // 10-12
  { inicioMinuto: 810, fimMinuto: 900 }, // 13:30-15
];
const base = { data, agendamentos, reservas: [], bloqueios: [], servicos, hoje: "2026-11-05" };
const itens = analisarLacunasDoDia(base);
assert.equal(itens.length, 1);
assert.equal(itens[0].inicio, "12:00");
assert.equal(itens[0].fim, "13:30");
assert.deepEqual(itens[0].opcoes.map(x => x.duracaoMinutos), [30, 60, 90]);
assert.deepEqual(itens[0].opcoes.find(x => x.duracaoMinutos === 90).horarios, ["12:00"]);
assert.ok(!itens[0].opcoes.find(x => x.duracaoMinutos === 60).horarios.includes("12:15"));
assert.ok(itens[0].opcoes.find(x => x.duracaoMinutos === 60).horarios.includes("12:00"));

const totalmenteOcupado = analisarLacunasDoDia({ ...base, reservas: [
  { inicioMinuto: 720, fimMinuto: 810 }
] });
assert.equal(totalmenteOcupado.length, 0);

const bloqueado = analisarLacunasDoDia({ ...base, bloqueios: [
  { inicioMinuto: 720, fimMinuto: 810 },
] });
assert.equal(bloqueado.length, 0);

const semVizinho = analisarLacunasDoDia({ ...base, agendamentos: [agendamentos[0]] });
assert.equal(semVizinho.length, 0);
const intervalo15 = analisarLacunasDoDia({ ...base, agendamentos: [
  { inicioMinuto: 600, fimMinuto: 720 }, { inicioMinuto: 735, fimMinuto: 900 },
] });
assert.equal(intervalo15.length, 0);
const horasAntigas = analisarLacunasDoDia({ ...base, hoje: data, agora: new Date("2026-11-06T18:00:00Z") });
assert.equal(horasAntigas.length, 0);
assert.deepEqual(analisarLacunasDoDia({
  ...base, data: "2026-11-08",
}), []); // domingo

assert.throws(() => analisarLacunasDoDia({ ...base, agendamentos: [
  { inicioMinuto: 600, fimMinuto: 730 }, { inicioMinuto: 720, fimMinuto: 900 },
] }), /sobrepostos/);

console.log("Assistente de Agenda: regras de encaixe excepcional aprovadas");

const expedientesDezembro = [
  { id: "ped", nome: "Pedicure Simples", categoria: "Pedicure", duracaoMinutos: 60 },
  { id: "man", nome: "Manicure Simples", categoria: "Manicure", duracaoMinutos: 60 },
];
const sextaDezembro = analisarLacunasDoDia({
  data: "2026-12-18",
  agendamentos: [
    { inicioMinuto: 540, fimMinuto: 600 },
    { inicioMinuto: 720, fimMinuto: 780 },
  ],
  reservas: [], bloqueios: [], servicos: expedientesDezembro, hoje: "2026-11-06",
});
assert.equal(sextaDezembro.length, 1);
assert.deepEqual(sextaDezembro[0].opcoes.map(x => x.servicoId), ["man"],
  "pedicure não pode ser sugerida durante suspensão de dezembro");

const vespera = analisarLacunasDoDia({
  data: "2026-12-24",
  agendamentos: [
    { inicioMinuto: 480, fimMinuto: 540 },
    { inicioMinuto: 660, fimMinuto: 720 },
  ],
  reservas: [], bloqueios: [], servicos: expedientesDezembro, hoje: "2026-11-06",
});
assert.deepEqual(vespera[0]?.opcoes.map(x => x.servicoId), ["man"],
  "24/12 permite somente os serviços autorizados");
