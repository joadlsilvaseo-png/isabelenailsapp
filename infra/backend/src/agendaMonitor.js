import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";

import { getFirestore } from "firebase-admin/firestore";
import { identificarNotificacoesAgendamento } from "./agendaNotificacoes.js";

const PROJECT_ID = "isabele-nails-app";

function texto(valor) {
  return String(valor ?? "").trim();
}

function normalizarStatus(valor) {
  return texto(valor || "agendado").toLowerCase();
}

// ======================================================
// CONVERTER AGENDAMENTO PARA ESTADO MONITORADO
// ======================================================

function extrairEstado(documento) {
  const dados = documento.data();

  return {
    id: documento.id,

    clienteId: texto(
      dados.clienteId ||
        dados.idCliente ||
        dados.usuarioId ||
        dados.uidCliente ||
        dados.userId,
    ),

    status: normalizarStatus(dados.status),

    data: texto(dados.data || dados.dataAgendamento),

    horario: texto(dados.horario || dados.hora),

    servico: texto(dados.servico || dados.nomeServico || dados.servicoNome),

    reagendadoPor: texto(dados.reagendadoPor),
    nomeCliente: texto(dados.nomeCliente),
    origemPagamento: texto(dados.origemPagamento),
  };
}

// ======================================================
// IDENTIFICAR O TIPO DE NOTIFICAÇÃO
// ======================================================

// ======================================================
// CONSULTAR ADMINISTRADORAS ATIVAS
// ======================================================

async function obterAdministradoras(firestore) {
  const snapshot = await firestore
    .collection("usuarios")
    .where("role", "==", "admin")
    .get();

  return snapshot.docs
    .filter((documento) => documento.data().ativo === true)
    .map((documento) => documento.id);
}

// ======================================================
// ATUALIZAR ESTADO E REGISTRAR EVENTO NO POSTGRESQL
// ======================================================

async function processarAgendamento(
  pool,
  firestore,
  documento,
  importacaoInicial,
) {
  const atual = extrairEstado(documento);
  const conexao = await pool.connect();

  try {
    await conexao.query("BEGIN");

    const resultado = await conexao.query(
      `
      SELECT *
      FROM public.push_agendamento_estado
      WHERE agendamento_id = $1
      FOR UPDATE
      `,
      [atual.id],
    );

    const anterior = resultado.rows[0] || null;

    const mudou =
      !anterior ||
      normalizarStatus(anterior.status) !== atual.status ||
      texto(anterior.data_agendamento) !== atual.data ||
      texto(anterior.horario) !== atual.horario ||
      texto(anterior.servico) !== atual.servico ||
      texto(anterior.cliente_id) !== atual.clienteId ||
      texto(anterior.reagendado_por) !== atual.reagendadoPor;

    if (!mudou) {
      await conexao.query("COMMIT");
      return;
    }

    const versao = anterior ? anterior.versao + 1 : 1;

    await conexao.query(
      `
      INSERT INTO public.push_agendamento_estado (
        agendamento_id,
        cliente_id,
        status,
        data_agendamento,
        horario,
        servico,
        reagendado_por,
        versao
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)

      ON CONFLICT (agendamento_id)
      DO UPDATE SET
        cliente_id = EXCLUDED.cliente_id,
        status = EXCLUDED.status,
        data_agendamento = EXCLUDED.data_agendamento,
        horario = EXCLUDED.horario,
        servico = EXCLUDED.servico,
        reagendado_por = EXCLUDED.reagendado_por,
        versao = EXCLUDED.versao,
        atualizado_em = NOW()
      `,
      [
        atual.id,
        atual.clienteId,
        atual.status,
        atual.data,
        atual.horario,
        atual.servico,
        atual.reagendadoPor,
        versao,
      ],
    );

    // Na primeira instalação, apenas importa as reservas
    // existentes sem gerar notificações antigas.
    const eventos = importacaoInicial
      ? []
      : identificarNotificacoesAgendamento(anterior, atual);

    if (!eventos.length) {
      await conexao.query("COMMIT");
      return;
    }

    for (const evento of eventos) {
      const destinatarios = evento.destinatario === "admin"
        ? await obterAdministradoras(firestore)
        : [atual.clienteId];

      for (const uid of new Set(destinatarios.filter(Boolean))) {
        const chaveEvento = `${atual.id}:${versao}:${evento.tipo}:${uid}`;
        await conexao.query(
        `
        INSERT INTO public.push_entregas (
          chave_evento,
          agendamento_id,
          destinatario_uid,
          tipo,
          titulo,
          mensagem,
          destino
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (chave_evento) DO NOTHING
        `,
        [
          chaveEvento,
          atual.id,
          uid,
          evento.tipo,
          evento.titulo,
          evento.mensagem,
          evento.destino,
        ],
        );
      }
    }

    await conexao.query("COMMIT");

    console.log("[AgendaMonitor] Eventos registrados:", eventos.length, atual.id);
  } catch (erro) {
    await conexao.query("ROLLBACK");
    throw erro;
  } finally {
    conexao.release();
  }
}

// ======================================================
// INICIAR MONITORAMENTO DO FIRESTORE
// ======================================================

export async function iniciarMonitorAgendamentos(pool) {
  if (process.env.FIREBASE_WATCH_ENABLED !== "true") {
    console.log("[AgendaMonitor] Monitoramento desativado.");
    return;
  }

  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  }

  const firestore = getFirestore();

  const controle = await pool.query(
    `
    SELECT 1
    FROM public.push_controle
    WHERE chave = 'agenda_inicializada'
    `,
  );

  const precisaImportar = controle.rowCount === 0;

  let primeiraLeitura = true;
  let fila = Promise.resolve();

  firestore.collection("agendamentos").onSnapshot(
    (snapshot) => {
      const importacaoInicial = primeiraLeitura && precisaImportar;

      primeiraLeitura = false;

      const alteracoes = snapshot
        .docChanges()
        .filter((alteracao) => alteracao.type !== "removed");

      fila = fila
        .then(async () => {
          for (const alteracao of alteracoes) {
            await processarAgendamento(
              pool,
              firestore,
              alteracao.doc,
              importacaoInicial,
            );
          }

          if (importacaoInicial) {
            await pool.query(
              `
            INSERT INTO public.push_controle (chave, valor)
            VALUES ('agenda_inicializada', 'true')
            ON CONFLICT (chave) DO NOTHING
            `,
            );

            console.log("[AgendaMonitor] Histórico inicial importado.");
          }
        })
        .catch((erro) => {
          console.error("[AgendaMonitor] Falha no processamento:", erro);

          // O Docker reiniciará o serviço e recuperará
          // as alterações com base no estado persistido.
          process.exit(1);
        });
    },

    (erro) => {
      console.error("[AgendaMonitor] Falha no listener Firestore:", erro);

      process.exit(1);
    },
  );

  console.log("[AgendaMonitor] Monitoramento iniciado.");
}
