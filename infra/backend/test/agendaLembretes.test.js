import test from "node:test";
import assert from "node:assert/strict";
import {
  agendamentoAtivo,
  criarLembretesAgendamento,
  extrairAgendamento,
  instanteAgendamentoSaoPaulo,
  sincronizarLembretesAgendamento,
} from "../src/agendaLembretes.js";
import { processarEntrega, validarLembreteAgendamento } from "../src/pushWorker.js";
import { FILTRO_VISIBILIDADE_CENTRAL } from "../src/centralNotificacoes.js";

const AGENDAMENTO = {
  id: "ag-1",
  clienteId: "cliente-1",
  status: "confirmado",
  data: "2026-11-07",
  horario: "15:00",
  servico: "Manicure",
};

function criarConexaoFake() {
  const entregas = new Map();
  return {
    entregas,
    async query(sql, parametros = []) {
      if (sql.includes("UPDATE public.push_entregas")) {
        const [agendamentoId, ativo, versao] = parametros;
        for (const entrega of entregas.values()) {
          if (
            entrega.agendamentoId === agendamentoId &&
            ["lembrete_24h", "lembrete_1h"].includes(entrega.tipo) &&
            ["pendente", "processando"].includes(entrega.estado) &&
            (!ativo || entrega.versao !== versao)
          ) {
            entrega.estado = "cancelado";
          }
        }
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("INSERT INTO public.push_entregas")) {
        const [chave, agendamentoId, uid, tipo, titulo, mensagem, destino, agendadoPara, versao] = parametros;
        if (!entregas.has(chave)) {
          entregas.set(chave, {
            chave,
            agendamentoId,
            uid,
            tipo,
            titulo,
            mensagem,
            destino,
            agendadoPara,
            versao,
            estado: "pendente",
          });
        }
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
}

test("converte a hora local usando America/Sao_Paulo", () => {
  assert.equal(
    instanteAgendamentoSaoPaulo("2026-11-07", "15:00").toISOString(),
    "2026-11-07T18:00:00.000Z",
  );
  assert.equal(instanteAgendamentoSaoPaulo("2026-02-30", "15:00"), null);
});

test("cria lembretes de 24h e 1h com texto e destino do perfil", () => {
  const lembretes = criarLembretesAgendamento(
    AGENDAMENTO,
    4,
    new Date("2026-11-06T12:00:00.000Z"),
  );
  assert.deepEqual(lembretes.map(({ tipo, agendadoPara }) => [tipo, agendadoPara.toISOString()]), [
    ["lembrete_24h", "2026-11-06T18:00:00.000Z"],
    ["lembrete_1h", "2026-11-07T17:00:00.000Z"],
  ]);
  assert.equal(lembretes[0].titulo, "Lembrete de Agendamento 💅");
  assert.equal(lembretes[0].mensagem, "Seu atendimento de Manicure está marcado para 07/11/2026, às 15:00. Estamos te esperando!");
  assert.equal(lembretes[0].destino, "./meu-perfil.html");
});

test("não cria lembrete atrasado nem para agendamento que já começou", () => {
  const faltamQuatroHoras = criarLembretesAgendamento(
    AGENDAMENTO,
    1,
    new Date("2026-11-07T14:00:00.000Z"),
  );
  assert.deepEqual(faltamQuatroHoras.map(({ tipo }) => tipo), ["lembrete_1h"]);
  assert.deepEqual(
    criarLembretesAgendamento(AGENDAMENTO, 1, new Date("2026-11-07T18:00:00.000Z")),
    [],
  );
});

test("central oculta lembretes futuros e cancelados até que sejam devidos", () => {
  assert.match(FILTRO_VISIBILIDADE_CENTRAL, /agendado_para IS NULL OR agendado_para <= NOW\(\)/);
  assert.match(FILTRO_VISIBILIDADE_CENTRAL, /lembrete_24h.*lembrete_1h.*estado <> 'cancelado'/s);
});

test("não agenda notificações para estados cancelados, concluídos ou expirados", () => {
  for (const status of ["cancelado_cliente", "cancelado_profissional", "concluido", "expirado"]) {
    const atual = { ...AGENDAMENTO, status };
    assert.equal(agendamentoAtivo(atual), false);
    assert.deepEqual(
      criarLembretesAgendamento(atual, 1, new Date("2026-11-06T12:00:00.000Z")),
      [],
    );
  }
});

test("reagendamento invalida a versão anterior e cria novos horários", async () => {
  const conexao = criarConexaoFake();
  await sincronizarLembretesAgendamento(conexao, AGENDAMENTO, 1, new Date("2026-11-06T12:00:00Z"));
  await sincronizarLembretesAgendamento(conexao, {
    ...AGENDAMENTO,
    status: "reagendado",
    data: "2026-11-08",
    horario: "12:30",
  }, 2, new Date("2026-11-06T12:00:00Z"));

  const antigas = [...conexao.entregas.values()].filter((item) => item.versao === 1);
  const novas = [...conexao.entregas.values()].filter((item) => item.versao === 2);
  assert.equal(antigas.length, 2);
  assert.ok(antigas.every((item) => item.estado === "cancelado"));
  assert.equal(novas.length, 2);
  assert.ok(novas.every((item) => item.estado === "pendente"));
});

test("cancelamento invalida os lembretes pendentes", async () => {
  const conexao = criarConexaoFake();
  await sincronizarLembretesAgendamento(conexao, AGENDAMENTO, 1, new Date("2026-11-06T12:00:00Z"));
  await sincronizarLembretesAgendamento(conexao, {
    ...AGENDAMENTO,
    status: "cancelado_cliente",
  }, 2, new Date("2026-11-06T12:00:00Z"));
  assert.ok([...conexao.entregas.values()].every((item) => item.estado === "cancelado"));
});

test("chaves únicas impedem duplicidade após reinicialização do monitor", async () => {
  const conexao = criarConexaoFake();
  const agora = new Date("2026-11-06T12:00:00Z");
  await sincronizarLembretesAgendamento(conexao, AGENDAMENTO, 1, agora);
  await sincronizarLembretesAgendamento(conexao, AGENDAMENTO, 1, agora);
  assert.equal(conexao.entregas.size, 2);
  assert.ok([...conexao.entregas.keys()].every((chave) => chave.includes(":1:lembrete_")));
});

test("worker cancela lembrete obsoleto sem chamar Web Push", async () => {
  let enviado = false;
  let estadoFinal = "";
  const pool = {
    async query(sql, parametros) {
      assert.match(sql, /UPDATE public\.push_entregas/);
      estadoFinal = parametros[1];
    },
  };
  const resultado = await processarEntrega(pool, {
    id: 10,
    tipo: "lembrete_24h",
    agendamento_id: "ag-1",
    destinatario_uid: "cliente-1",
    agendamento_versao: 1,
  }, {
    validar: async () => null,
    enviar: async () => { enviado = true; return "enviado"; },
  });
  assert.equal(resultado, "cancelado");
  assert.equal(estadoFinal, "cancelado");
  assert.equal(enviado, false);
});

test("revalidação confere status, cliente e horário atual no Firestore", async () => {
  const salvo = {
    agendamento_id: "ag-1",
    cliente_id: "cliente-1",
    status: "confirmado",
    data_agendamento: AGENDAMENTO.data,
    horario: AGENDAMENTO.horario,
    servico: AGENDAMENTO.servico,
    versao: 4,
  };
  const pool = {
    async query(_sql, parametros) {
      assert.deepEqual(parametros, ["ag-1", "cliente-1", 4]);
      return { rows: [salvo] };
    },
  };
  let documento = { ...AGENDAMENTO };
  const firestore = {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, id: "ag-1", data: () => documento }) }),
    }),
  };
  const entrega = {
    tipo: "lembrete_1h",
    agendamento_id: "ag-1",
    destinatario_uid: "cliente-1",
    agendamento_versao: 4,
  };

  const valido = await validarLembreteAgendamento(
    pool, entrega, firestore, new Date("2026-11-07T16:00:00Z"),
  );
  assert.equal(valido.inicio.toISOString(), "2026-11-07T18:00:00.000Z");

  documento = { ...documento, status: "cancelado_cliente" };
  assert.equal(
    await validarLembreteAgendamento(pool, entrega, firestore, new Date("2026-11-07T16:00:00Z")),
    null,
  );

  documento = { ...documento, status: "confirmado" };
  assert.equal(
    await validarLembreteAgendamento(pool, entrega, firestore, new Date("2026-11-07T18:00:00Z")),
    null,
  );
});

test("extrai campos legados do documento sem alterar a interface", () => {
  assert.deepEqual(extrairAgendamento({ idCliente: "c1", nomeServico: "Gel", hora: "09:30:00" }, "x"), {
    id: "x",
    clienteId: "c1",
    status: "agendado",
    data: "",
    horario: "09:30",
    servico: "Gel",
    nomeCliente: "",
    origemPagamento: "",
  });
});
