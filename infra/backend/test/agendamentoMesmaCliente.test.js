import assert from "node:assert/strict";
import { conflitaComAtendimentoDaCliente, indisponivelComBuffer } from "../src/agendaBuffer.mjs";
import { encontrarConflitoAgendamentoPix } from "../src/pixDocumentoAgendamento.js";

const agendamento = { inicioMinuto: 960, fimMinuto: 1020, tipo: "agendamento", mesmaCliente: true };
const anterior = [{...agendamento}];
assert.equal(indisponivelComBuffer(1020, 1140, anterior), false, "mesma cliente 16-17 seguido 17-19");
assert.equal(indisponivelComBuffer(900, 960, anterior), false, "mesma cliente antes também");
assert.equal(indisponivelComBuffer(1035, 1140, anterior), false, "após buffer normal");
assert.equal(indisponivelComBuffer(1025, 1140, anterior), true, "intervalo de 5 minutos não é consecutivo");
assert.equal(indisponivelComBuffer(1015, 1140, anterior), true, "sobreposição nunca é permitida");
assert.equal(indisponivelComBuffer(1020, 1140, [{...agendamento, mesmaCliente:false}]), true, "cliente diferente exige buffer");
assert.equal(indisponivelComBuffer(1020, 1140, [
  agendamento, {inicioMinuto:1020,fimMinuto:1035,tipo:"bloqueio",mesmaCliente:true},
]), true, "bloqueio de profissional prevalece");
assert.equal(conflitaComAtendimentoDaCliente(1020,1140,960,1020,true),false);
assert.equal(conflitaComAtendimentoDaCliente(1020,1140,960,1020,false),true);
const ativos=[{horario:"16:00",duracao:60,status:"confirmado",clienteId:"cliente-a"}];
assert.equal(encontrarConflitoAgendamentoPix(ativos,1020,1140,15,"cliente-a"),false);
assert.equal(encontrarConflitoAgendamentoPix(ativos,1020,1140,15,"cliente-b"),true);
assert.equal(encontrarConflitoAgendamentoPix(ativos,1015,1140,15,"cliente-a"),true);
assert.equal(encontrarConflitoAgendamentoPix(ativos,1020,1140),true,"sem UID exceção desativada");
console.log("Consecutivos mesma cliente: buffers protegidos e sobreposições rejeitadas");
