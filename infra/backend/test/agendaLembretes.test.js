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
import {
  atenderCentralNotificacoes,
  FILTRO_VISIBILIDADE_CENTRAL,
} from "../src/centralNotificacoes.js";

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

function criarEntregaLembrete(tipo, agendadoPara) {
  return {
    id: 10,
    tipo,
    agendamento_id: "ag-1",
    destinatario_uid: "cliente-1",
    agendamento_versao: 1,
    agendado_para: new Date(agendadoPara),
    tentativas: 1,
  };
}

function criarRespostaFake() {
  return {
    status: 0,
    headers: {},
    corpo: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(corpo) {
      this.corpo = corpo;
    },
  };
}

async function executarRotaCentral(caminho, pool, method = "PATCH") {
  const resposta = criarRespostaFake();
  await atenderCentralNotificacoes(
    { method, url: caminho, headers: {} },
    resposta,
    pool,
    { verificarUsuario: async () => "cliente-1" },
  );
  return { ...resposta, dados: JSON.parse(resposta.corpo) };
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

test("marcar todas como lidas altera apenas notificações visíveis", async () => {
  const consultas = [];
  const pool = {
    async query(sql) {
      consultas.push(sql);
      return { rowCount: 2 };
    },
  };

  const resposta = await executarRotaCentral("/notificacoes/lidas", pool);

  assert.equal(resposta.status, 200);
  assert.equal(resposta.dados.quantidade, 2);
  assert.match(consultas[0], /agendado_para IS NULL OR agendado_para <= NOW\(\)/);
  assert.match(consultas[0], /lembrete_24h.*lembrete_1h.*estado <> 'cancelado'/s);
});

test("lembretes futuros continuam não lidos e lembretes cancelados não aparecem", async () => {
  const agora = new Date("2026-11-07T18:00:00.000Z");
  const notificacoes = [
    { id: "1", tipo: "agendamento_criado", estado: "enviado", agendado_para: null, lida_em: null },
    { id: "2", tipo: "lembrete_24h", estado: "pendente", agendado_para: new Date("2026-11-07T18:30:00.000Z"), lida_em: null },
    { id: "3", tipo: "lembrete_1h", estado: "cancelado", agendado_para: new Date("2026-11-07T19:00:00.000Z"), lida_em: null },
    { id: "4", tipo: "lembrete_1h", estado: "enviado", agendado_para: new Date("2026-11-07T17:00:00.000Z"), lida_em: null },
    { id: "5", tipo: "lembrete_24h", estado: "cancelado", agendado_para: new Date("2026-11-07T17:00:00.000Z"), lida_em: null },
  ];
  const visivel = (notificacao) =>
    (!notificacao.agendado_para || notificacao.agendado_para <= agora) &&
    (!["lembrete_24h", "lembrete_1h"].includes(notificacao.tipo) || notificacao.estado !== "cancelado");
  const pool = {
    async query(sql) {
      assert.match(sql, /agendado_para IS NULL OR agendado_para <= NOW\(\)/);
      assert.match(sql, /estado <> 'cancelado'/);
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ total: notificacoes.filter((item) => visivel(item) && item.lida_em === null).length }] };
      }
      if (sql.includes("SELECT") && !sql.includes("UPDATE")) {
        return { rows: notificacoes.filter(visivel).map(({ id, tipo }) => ({ id, tipo })) };
      }
      if (sql.includes("UPDATE public.push_entregas")) {
        let rowCount = 0;
        for (const item of notificacoes) {
          if (item.lida_em === null && visivel(item)) {
            item.lida_em = agora;
            rowCount++;
          }
        }
        return { rowCount };
      }
      throw new Error("Consulta inesperada na central");
    },
  };

  const consulta = await executarRotaCentral("/notificacoes", pool, "GET");
  assert.deepEqual(consulta.dados.notificacoes.map(({ id }) => id), ["1", "4"]);
  assert.equal(consulta.dados.naoLidas, 2);

  const marcar = await executarRotaCentral("/notificacoes/lidas", pool);
  assert.equal(marcar.dados.quantidade, 2);
  assert.equal(notificacoes.find(({ id }) => id === "2").lida_em, null);
  assert.equal(notificacoes.find(({ id }) => id === "3").lida_em, null);
  assert.equal(notificacoes.find(({ id }) => id === "1").lida_em.toISOString(), agora.toISOString());
  assert.equal(notificacoes.find(({ id }) => id === "4").lida_em.toISOString(), agora.toISOString());
});

test("marcar individualmente não altera lembrete futuro ou cancelado, mas aceita notificação comum", async () => {
  const consultas = [];
  const pool = {
    async query(sql, parametros) {
      consultas.push({ sql, parametros });
      return { rowCount: parametros[0] === "10" ? 0 : 1 };
    },
  };

  const futura = await executarRotaCentral("/notificacoes/10/lida", pool);
  const comum = await executarRotaCentral("/notificacoes/11/lida", pool);

  assert.equal(futura.status, 404);
  assert.equal(comum.status, 200);
  assert.ok(consultas.every(({ sql }) => /agendado_para IS NULL OR agendado_para <= NOW\(\)/.test(sql)));
  assert.ok(consultas.every(({ sql }) => /lembrete_24h.*lembrete_1h.*estado <> 'cancelado'/s.test(sql)));
  assert.deepEqual(consultas.map(({ parametros }) => parametros), [
    ["10", "cliente-1"],
    ["11", "cliente-1"],
  ]);
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
    ...criarEntregaLembrete("lembrete_24h", "2026-11-06T17:55:00.000Z"),
  }, {
    agora: new Date("2026-11-06T18:00:00.000Z"),
    validar: async () => null,
    enviar: async () => { enviado = true; return "enviado"; },
  });
  assert.equal(resultado, "cancelado");
  assert.equal(estadoFinal, "cancelado");
  assert.equal(enviado, false);
});

test("envia os dois tipos de lembrete até o limite de 10 minutos", async () => {
  for (const tipo of ["lembrete_24h", "lembrete_1h"]) {
    let enviado = 0;
    let estadoFinal = "";
    const agora = new Date("2026-11-07T18:10:00.000Z");
    const pool = {
      async query(_sql, parametros) {
        estadoFinal = parametros[1];
      },
    };

    const resultado = await processarEntrega(
      pool,
      criarEntregaLembrete(tipo, "2026-11-07T18:00:00.000Z"),
      {
        agora,
        validar: async () => ({ inicio: new Date("2026-11-07T19:00:00.000Z") }),
        enviar: async () => { enviado++; return "enviado"; },
      },
    );

    assert.equal(resultado, "enviado", `${tipo} deve continuar válido aos 10 minutos`);
    assert.equal(enviado, 1);
    assert.equal(estadoFinal, "enviado");
  }
});

test("descarta ambos os lembretes após mais de 10 minutos e não tenta Web Push", async () => {
  for (const tipo of ["lembrete_24h", "lembrete_1h"]) {
    let enviado = false;
    let estadoFinal = "";
    const pool = {
      async query(_sql, parametros) {
        estadoFinal = parametros[1];
      },
    };

    const resultado = await processarEntrega(
      pool,
      criarEntregaLembrete(tipo, "2026-11-07T18:00:00.000Z"),
      {
        agora: new Date("2026-11-07T18:10:00.001Z"),
        validar: async () => { throw new Error("não deve validar lembrete vencido"); },
        enviar: async () => { enviado = true; return "enviado"; },
      },
    );

    assert.equal(resultado, "expirada");
    assert.equal(estadoFinal, "expirada");
    assert.equal(enviado, false);
  }
});

test("retry recuperado após reinício expira entrega antiga e não duplica Push", async () => {
  let quantidadeEnvios = 0;
  let estadoFinal = "processando";
  const pool = {
    async query(_sql, parametros) {
      estadoFinal = parametros[1];
    },
  };
  const entrega = criarEntregaLembrete("lembrete_1h", "2026-11-07T18:00:00.000Z");
  const antesDoReinicio = new Date("2026-11-07T18:09:00.000Z");

  await assert.rejects(
    processarEntrega(pool, entrega, {
      agora: antesDoReinicio,
      validar: async () => ({ inicio: new Date("2026-11-07T19:00:00.000Z") }),
      enviar: async () => {
        quantidadeEnvios++;
        throw new Error("falha temporária antes de confirmar entrega");
      },
    }),
  );

  const depoisDoReinicio = await processarEntrega(pool, entrega, {
    agora: new Date("2026-11-07T18:11:00.000Z"),
    validar: async () => { throw new Error("não deve validar entrega expirada"); },
    enviar: async () => { quantidadeEnvios++; return "enviado"; },
  });

  assert.equal(depoisDoReinicio, "expirada");
  assert.equal(estadoFinal, "expirada");
  assert.equal(quantidadeEnvios, 1);
});

test("falha temporária ainda permite retry enquanto o lembrete está dentro da janela", async () => {
  let quantidadeValidacoes = 0;
  let quantidadeEnvios = 0;
  let estadoFinal = "";
  const pool = {
    async query(_sql, parametros) {
      estadoFinal = parametros[1];
    },
  };
  const entrega = criarEntregaLembrete("lembrete_24h", "2026-11-07T18:00:00.000Z");
  const enviarComFalhaTemporaria = async () => {
    quantidadeEnvios++;
    if (quantidadeEnvios === 1) throw new Error("erro temporário de rede");
    return "enviado";
  };

  await assert.rejects(
    processarEntrega(pool, entrega, {
      agora: new Date("2026-11-07T18:02:00.000Z"),
      validar: async () => {
        quantidadeValidacoes++;
        return { inicio: new Date("2026-11-07T19:00:00.000Z") };
      },
      enviar: enviarComFalhaTemporaria,
    }),
  );

  const retry = await processarEntrega(pool, entrega, {
    agora: new Date("2026-11-07T18:03:00.000Z"),
    validar: async () => {
      quantidadeValidacoes++;
      return { inicio: new Date("2026-11-07T19:00:00.000Z") };
    },
    enviar: enviarComFalhaTemporaria,
  });

  assert.equal(retry, "enviado");
  assert.equal(quantidadeValidacoes, 2);
  assert.equal(quantidadeEnvios, 2);
  assert.equal(estadoFinal, "enviado");
});

test("cancelamento ou reagendamento invalida lembrete antes do envio", async () => {
  for (const cenario of ["cancelamento", "reagendamento"]) {
    let estadoFinal = "";
    let enviado = false;
    const pool = {
      async query(sql, parametros) {
        if (sql.includes("SELECT agendamento_id")) {
          return {
            rows: cenario === "cancelamento"
              ? [{ ...AGENDAMENTO, agendamento_id: "ag-1", cliente_id: "cliente-1", versao: 1 }]
              : [],
          };
        }
        estadoFinal = parametros[1];
        return { rowCount: 1, rows: [] };
      },
    };
    const firestore = {
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            id: "ag-1",
            data: () => cenario === "cancelamento"
              ? { ...AGENDAMENTO, status: "cancelado_cliente" }
              : { ...AGENDAMENTO, data: "2026-11-08", horario: "12:30", status: "reagendado" },
          }),
        }),
      }),
    };

    const resultado = await processarEntrega(
      pool,
      criarEntregaLembrete("lembrete_1h", "2026-11-07T18:00:00.000Z"),
      {
        agora: new Date("2026-11-07T18:05:00.000Z"),
        firestore,
        validar: validarLembreteAgendamento,
        enviar: async () => { enviado = true; return "enviado"; },
      },
    );

    assert.equal(resultado, "cancelado", cenario);
    assert.equal(estadoFinal, "cancelado", cenario);
    assert.equal(enviado, false, cenario);
  }
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
