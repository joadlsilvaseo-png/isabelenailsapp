import test from "node:test";
import assert from "node:assert/strict";
import { identificarNotificacoesAgendamento } from "../src/agendaNotificacoes.js";

const agendaOriginal = {
  status: "confirmado", data_agendamento: "2026-12-04",
  horario: "14:00", servico: "Manicure em Gel"
};
const dadosAtuais = {
  status: "confirmado", data: "2026-12-04", horario: "14:00",
  servico: "Manicure em Gel", nomeCliente: "Ana Souza",
  clienteId: "cliente-1"
};

test("cancelamento da cliente identifica quem cancelou e serviço/data/hora para administradora", () => {
  const [evento] = identificarNotificacoesAgendamento(agendaOriginal, {
    ...dadosAtuais, status: "cancelado_cliente"
  });
  assert.equal(evento.tipo, "cancelamento_cliente");
  assert.equal(evento.destinatario, "admin");
  assert.equal(evento.titulo, "Agendamento cancelado");
  assert.equal(evento.destino, "./admin-agendamentos.html");
  assert.equal(evento.mensagem,
    "Ana Souza cancelou o agendamento de Manicure em Gel, marcado para 04/12/2026 às 14:00.");
});

test("cancelamento pela profissional informa a cliente em segunda pessoa com data e serviço", () => {
  const [evento] = identificarNotificacoesAgendamento(agendaOriginal, {
    ...dadosAtuais, status: "cancelado_profissional"
  });
  assert.equal(evento.tipo, "cancelamento_profissional");
  assert.equal(evento.destinatario, "cliente");
  assert.equal(evento.destino, "./meu-perfil.html");
  assert.equal(evento.mensagem,
    "Seu agendamento de Manicure em Gel, marcado para 04/12/2026 às 14:00, foi cancelado pela Isabele.");
});

test("reagendamento pela cliente inclui nome, serviço, origem e novo horário para a profissional", () => {
  const [evento] = identificarNotificacoesAgendamento(agendaOriginal, {
    ...dadosAtuais, status: "reagendado", data: "2026-12-08",
    horario: "15:30", reagendadoPor: "cliente-1"
  });
  assert.equal(evento.tipo, "reagendamento");
  assert.equal(evento.destinatario, "admin");
  assert.equal(evento.destino, "./admin-agendamentos.html");
  assert.equal(evento.mensagem,
    "Ana Souza reagendou Manicure em Gel. Anterior: 04/12/2026 às 14:00. Novo: 08/12/2026 às 15:30.");
});

test("reagendamento pela profissional informa a cliente com origem e destino", () => {
  const [evento] = identificarNotificacoesAgendamento(agendaOriginal, {
    ...dadosAtuais, status: "reagendado", data: "2026-12-08",
    horario: "15:30", reagendadoPor: "admin-1"
  });
  assert.equal(evento.destinatario, "cliente");
  assert.equal(evento.destino, "./meu-perfil.html");
  assert.equal(evento.mensagem,
    "Seu atendimento de Manicure em Gel foi reagendado pela Isabele. Anterior: 04/12/2026 às 14:00. Novo: 08/12/2026 às 15:30.");
});

test("segundo reagendamento também notifica quando o status já era reagendado", () => {
  const [evento] = identificarNotificacoesAgendamento({
    status: "reagendado", data_agendamento: "2026-12-08", horario: "15:30"
  }, {
    ...dadosAtuais, status: "reagendado", data: "2026-12-08",
    horario: "16:00", reagendadoPor: "cliente-1"
  });
  assert.match(evento.mensagem, /Anterior: 08\/12\/2026 às 15:30/);
  assert.match(evento.mensagem, /Novo: 08\/12\/2026 às 16:00/);
  assert.equal(evento.destinatario, "admin");
});

test("sem horário anterior conhecido não inventa origem e não exibe undefined", () => {
  const [evento] = identificarNotificacoesAgendamento({ status: "confirmado" }, {
    ...dadosAtuais, status: "reagendado", data: "2026-12-08",
    horario: "15:30", reagendadoPor: "cliente-1"
  });
  assert.doesNotMatch(evento.mensagem, /Anterior:|undefined|null/);
  assert.match(evento.mensagem, /Novo: 08\/12\/2026 às 15:30/);
});

test("não notifica novamente cancelamento ou reagendamento sem mudança real", () => {
  assert.deepEqual(identificarNotificacoesAgendamento(
    { status: "cancelado_cliente" }, { ...dadosAtuais, status: "cancelado_cliente" }), []);
  assert.deepEqual(identificarNotificacoesAgendamento(
    { status: "reagendado", data_agendamento: "2026-12-04", horario: "14:00" },
    { ...dadosAtuais, status: "reagendado", reagendadoPor: "cliente-1" }), []);
});

test("novo agendamento permanece com textos, tipos e destinatários originais", () => {
  const eventos = identificarNotificacoesAgendamento(null, {
    ...dadosAtuais, origemPagamento: "mercado_pago_pix"
  });
  assert.deepEqual(eventos.map(e => e.tipo), ["confirmacao_pix_cliente", "novo_agendamento_pix_admin"]);
  assert.match(eventos[1].mensagem, /Ana Souza confirmou o atendimento de Manicure em Gel/);
});
