import { randomUUID } from "node:crypto";
import { verificarUsuario } from "./pushSubscriptions.js";
import { obterDuracaoAgendamentoPix, encontrarConflitoAgendamentoPix } from "./pixDocumentoAgendamento.js";
import { converterPrecoServicoCentavos } from "./pixSinalServico.js";
import { possuiBloqueio } from "./agendaBloqueios.js";
import { URL_APPS_SCRIPT } from "./pixCalendarWorker.js";
import { BUFFER_ENTRE_ATENDIMENTOS_MINUTOS } from "./agendaBuffer.mjs";
import { verificarEncaixeNoBanco } from "./pixEncaixes.js";
import { STATUS_ALTERAVEIS_SERVICO, calcularRestanteServicoCentavos, validarNovoPeriodoServico } from "./agendamentoAlteracaoServicoRegras.mjs";

// Eventos PIX: REAGENDAR no Apps Script original do worker, preservando eventId.
// Eventos sem PIX: ATUALIZAR no Apps Script do agendamento frontend.
// Nenhuma alteração é autorizada sem ISABELE_ALTERAR_SERVICO_ENABLED=true.
const URL_ATUALIZAR_ENV = "ISABELE_ALTERAR_SERVICO_APPS_SCRIPT_URL";
const FLAG_ATUALIZAR_ENV = "ISABELE_ALTERAR_SERVICO_ENABLED";
const PADRAO_URL_ATUALIZAR = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ATIVOS = STATUS_ALTERAVEIS_SERVICO;
const ERRO_LIMPEZA_MARCADOR = "LIMPEZA_MARCADOR_FIRESTORE_PENDENTE";

function urlAppsScriptAtualizar(dependencies = {}) {
  return String(dependencies.appsScriptAtualizarUrl ?? process.env[URL_ATUALIZAR_ENV] ?? "").trim();
}

function alterarServicoHabilitado(dependencies = {}) {
  // Override restrito às dependências injetadas de testes; nunca vem do request.
  if (dependencies.alteracaoServicoHabilitada === true) return true;
  return process.env[FLAG_ATUALIZAR_ENV] === "true" &&
    PADRAO_URL_ATUALIZAR.test(urlAppsScriptAtualizar());
}

export class ErroAlteracaoServico extends Error {
  constructor(status, message, permanente = status >= 400 && status < 500) {
    super(message);
    this.status = status;
    this.permanente = permanente;
  }
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

async function lerJson(req) {
  let bytes = 0;
  const partes = [];
  for await (const parte of req) {
    bytes += parte.length;
    if (bytes > 8192) throw new ErroAlteracaoServico(413, "Requisição muito grande");
    partes.push(parte);
  }
  try {
    const dados = JSON.parse(Buffer.concat(partes).toString("utf8"));
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new Error("JSON inválido");
    return dados;
  } catch {
    throw new ErroAlteracaoServico(400, "JSON inválido");
  }
}

async function firestorePadrao() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  return getFirestore();
}

async function fieldValuePadrao() {
  const { FieldValue } = await import("firebase-admin/firestore");
  return FieldValue;
}

async function verificarAdmin(db, uid) {
  const perfil = await db.collection("usuarios").doc(uid).get();
  return perfil.exists && perfil.data()?.role === "admin" && perfil.data()?.ativo === true;
}

function formatarHorario(minuto) {
  return `${String(Math.floor(minuto / 60)).padStart(2, "0")}:${String(minuto % 60).padStart(2, "0")}`;
}

function extrairPreco(servico) {
  try { return converterPrecoServicoCentavos(servico.preco ?? servico.valor ?? servico.valorReferencia); }
  catch { throw new ErroAlteracaoServico(409, "O serviço selecionado tem preço inválido."); }
}

function extrairDuracao(servico) {
  const duracao = Number(servico.duracao ?? servico.duracaoMinutos ?? servico.tempo);
  if (!Number.isSafeInteger(duracao) || duracao <= 0 || duracao > 600) {
    throw new ErroAlteracaoServico(409, "O serviço selecionado tem duração inválida.");
  }
  return duracao;
}

function dadosPeriodo(agendamento) {
  const data = String(agendamento.data || agendamento.dataAgendamento || "");
  const horario = String(agendamento.horario || "").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) {
    throw new ErroAlteracaoServico(409, "O agendamento não tem data ou horário válidos.");
  }
  return { data, horario, inicio: Number(horario.slice(0, 2)) * 60 + Number(horario.slice(3, 5)) };
}

function usarCalendarPix(operacao) {
  // O agendamento com sinal isento usa a mesma outbox Calendar do PIX pago.
  // Isso NÃO o transforma em pagamento e não modifica o cálculo financeiro.
  return operacao.pix_pago === true || operacao.calendar_isencao === true;
}

function montarPayloadAtualizacaoCalendar(operacao) {
  return {
    // Sinal PIX: usar REAGENDAR do mesmo script que criou o evento.
    // Demais agendamentos: ATUALIZAR no script usado pelo frontend original.
    acao: usarCalendarPix(operacao) ? "REAGENDAR" : "ATUALIZAR",
    eventId: operacao.calendar_event_id,
    operationId: operacao.operation_id,
    nomeCliente: operacao.nome_cliente,
    servico: operacao.novo_servico_nome,
    dataInicio: `${operacao.data_servico}T${formatarHorario(Number(operacao.inicio_minuto))}:00`,
    duracaoMinutos: Number(operacao.duracao_nova),
  };
}

export async function enviarAtualizacaoCalendar(operacao, fetcher = fetch, url = process.env[URL_ATUALIZAR_ENV]) {
  const destino = usarCalendarPix(operacao) ? URL_APPS_SCRIPT : String(url || "").trim();
  if (!PADRAO_URL_ATUALIZAR.test(destino)) {
    throw new ErroAlteracaoServico(503, "Integração ATUALIZAR indisponível; nenhuma alteração foi enviada ao Google Calendar.", false);
  }
  const payload = montarPayloadAtualizacaoCalendar(operacao);
  const resposta = await fetcher(destino, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!resposta.ok) throw new ErroAlteracaoServico(502, "Google Calendar não confirmou a atualização do evento.", false);
  const texto = await resposta.text();
  let corpo;
  try { corpo = JSON.parse(texto); } catch { corpo = null; }
  const confirmado = payload.acao === "REAGENDAR"
    ? corpo?.status === "REAGENDADO"
    : corpo?.updated === true;
  if (corpo?.ok !== true || !confirmado || corpo?.eventId !== payload.eventId) {
    throw new ErroAlteracaoServico(409, "O Apps Script não confirmou a alteração do mesmo evento; nenhuma alteração local foi aplicada.");
  }
  return payload;
}

async function gravarSnapshotOperacao(pool, operationId, snapshot) {
  await pool.query(`
    UPDATE public.agendamento_alteracoes_servico
    SET cliente_uid = $2, nome_cliente = $3, data_servico = $4,
        inicio_minuto = $5, calendar_event_id = $6,
        servico_anterior_id = $7, servico_anterior_nome = $8,
        duracao_anterior = $9, preco_anterior_centavos = $10,
        servico_novo_nome = $11, duracao_nova = $12,
        preco_novo_centavos = $13, sinal_pago_centavos = $14,
        restante_novo_centavos = GREATEST(0::bigint, $13::bigint - $14::bigint),
        atualizado_em = NOW()
    WHERE operation_id = $1 AND estado IN ('solicitada', 'processando')
  `, [operationId, snapshot.clienteUid, snapshot.nomeCliente, snapshot.data,
    snapshot.inicio, snapshot.eventId, snapshot.servicoAnteriorId,
    snapshot.servicoAnteriorNome, snapshot.duracaoAnterior,
    snapshot.precoAnteriorCentavos, snapshot.servicoNovoNome,
    snapshot.duracaoNova, snapshot.precoNovoCentavos,
    snapshot.sinalPagoCentavos]);
}

async function limparMarcadorPendente(db, operation, operationId, FieldValue) {
  const referencia = db.collection("agendamentos").doc(operation.agendamento_id);
  await db.runTransaction(async (transacao) => {
    const atual = await transacao.get(referencia);
    if (atual.exists && atual.data()?.alteracaoServicoOperacaoPendente === operationId) {
      transacao.update(referencia, {
        alteracaoServicoOperacaoPendente: FieldValue.delete(),
      });
    }
  });
}

async function prepararSnapshot({ pool, db, operacao, dependencies }) {
  const referencia = db.collection("agendamentos").doc(operacao.agendamento_id);
  const snap = await referencia.get();
  if (!snap.exists) throw new ErroAlteracaoServico(404, "Agendamento não encontrado.");
  const atual = snap.data();
  if (atual.alteracaoServicoOperacaoId === operacao.operation_id) {
    const servicoSnap = await db.collection("servicos").doc(operacao.servico_novo_id).get();
    const servicoNovo = servicoSnap.exists ? servicoSnap.data() : {};
    const data = String(operacao.data_servico || atual.data || "");
    const inicio = Number(operacao.inicio_minuto);
    const duracaoNova = Number(operacao.duracao_nova);
    const precoNovoCentavos = Number(operacao.preco_novo_centavos);
    const sinalPagoCentavos = Number(operacao.sinal_pago_centavos || 0);
    if (!data || !Number.isInteger(inicio) || !Number.isInteger(duracaoNova) || !Number.isSafeInteger(precoNovoCentavos)) {
      throw new ErroAlteracaoServico(409, "O estado parcial da alteração requer revisão administrativa.");
    }
    const reservaResult = await pool.query(`
      SELECT r.id AS reserva_id, r.cliente_uid, r.servico_id AS reserva_servico_id,
             r.data_servico::text AS reserva_data, r.inicio_minuto AS reserva_inicio,
             r.fim_minuto AS reserva_fim, r.estado AS reserva_estado,
             r.cobranca_id, r.agendamento_id,
             c.estado AS cobranca_estado, c.valor_sinal_centavos,
             c.agendamento_id AS cobranca_agendamento_id
      FROM public.pix_reservas r
      LEFT JOIN public.pix_cobrancas c ON c.id = r.cobranca_id
      WHERE r.agendamento_id = $1
    `, [operacao.agendamento_id]);
    return {
      jaAplicadaNoFirestore: true, atual, referencia, servicoNovo,
      data, inicio, horario: formatarHorario(inicio),
      eventId: String(operacao.calendar_event_id || atual.calendarEventId || ""),
      clienteUid: String(operacao.cliente_uid || atual.clienteId || ""),
      nomeCliente: String(operacao.nome_cliente || atual.nomeCliente || "Cliente"),
      servicoAnteriorId: String(operacao.servico_anterior_id || ""),
      servicoAnteriorNome: String(operacao.servico_anterior_nome || "Serviço anterior"),
      duracaoAnterior: Number(operacao.duracao_anterior),
      precoAnteriorCentavos: Number(operacao.preco_anterior_centavos || 0),
      servicoNovoNome: String(operacao.servico_novo_nome || atual.servico || "Serviço"),
      duracaoNova, precoNovoCentavos,
      sinalPagoCentavos,
      restanteNovoCentavos: calcularRestanteServicoCentavos(precoNovoCentavos, sinalPagoCentavos),
      possuiPix: Boolean(atual.pixCobrancaId || atual.pixPagamentoId),
      calendarIsento: atual.origemPagamento === "isencao_sinal_pix",
      reserva: reservaResult.rows[0] || null,
      periodo: validarNovoPeriodoServico({ data, horario: formatarHorario(inicio), duracao: duracaoNova, servico: servicoNovo, now: dependencies.now }),
    };
  }
  if (atual.reagendamentoPixOperacaoPendente) {
    throw new ErroAlteracaoServico(409, "Reagendamento PIX ainda em processamento.");
  }
  const reagendamentoPendente = await pool.query(`
    SELECT 1 FROM public.pix_reagendamentos_pagos
    WHERE agendamento_id = $1 AND estado <> 'concluida' LIMIT 1
  `, [operacao.agendamento_id]);
  if (reagendamentoPendente.rowCount) {
    throw new ErroAlteracaoServico(409, "Reagendamento com PIX pago em andamento; aguarde a conclusão.");
  }
  if (!ATIVOS.has(String(atual.status || ""))) throw new ErroAlteracaoServico(409, "Somente agendamentos ativos podem ter o serviço alterado.");
  const { data, horario, inicio } = dadosPeriodo(atual);
  const duracaoAnterior = obterDuracaoAgendamentoPix(atual.duracao ?? atual.duracaoSnapshot);
  const servicoSnap = await db.collection("servicos").doc(operacao.servico_novo_id).get();
  if (!servicoSnap.exists || servicoSnap.data()?.ativo === false) throw new ErroAlteracaoServico(404, "O serviço selecionado não está ativo.");
  const servicoNovo = servicoSnap.data();
  const duracaoNova = extrairDuracao(servicoNovo);
  const precoNovoCentavos = extrairPreco(servicoNovo);
  const periodo = dependencies.validarNovoPeriodo
    ? dependencies.validarNovoPeriodo(data, horario, duracaoNova, servicoNovo)
    : validarNovoPeriodoServico({ data, horario, duracao: duracaoNova, servico: servicoNovo, now: dependencies.now });
  if (!periodo.valido) throw new ErroAlteracaoServico(409, `O novo período não é permitido: ${periodo.motivo}`);
  const eventId = String(atual.calendarEventId || "");
  if (!eventId) throw new ErroAlteracaoServico(409, "O evento não tem identificador estável; a alteração foi bloqueada para evitar duplicidade no Calendar.");

  const reservaResult = await pool.query(`
    SELECT r.id AS reserva_id, r.cliente_uid, r.servico_id AS reserva_servico_id,
           r.data_servico::text AS reserva_data, r.inicio_minuto AS reserva_inicio,
           r.fim_minuto AS reserva_fim, r.estado AS reserva_estado,
           r.cobranca_id, r.agendamento_id,
           c.estado AS cobranca_estado, c.valor_…43106 tokens truncated…pendencies: f.dependencies }),
    /simulated commit failure/,
  );
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 0);
});

test("falha no Firestore faz rollback da reserva PostgreSQL", async () => {
  const f = criarFixture({ falharFirestore: true });
  await assert.rejects(
    criarAgendamentoIsento({ pool: f.pool, db: f.firestore, uid: UID, dados: payload(), dependencies: f.dependencies }),
    /simulated Firestore failure/,
  );
  assert.equal(f.state.reservas.length, 0);
  assert.equal([...f.state.documentos.keys()].filter((chave) => chave.startsWith("agendamentos/")).length, 0);
});

test("reagendamento seguro valida conflito e preserva evento da agenda", async () => {
  const f = criarFixture({ isenta: false, documentos: {
    "agendamentos/original": { clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60, status: "confirmado", calendarEventId: "evt_original" },
  } });
  const resultado = await reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  });
  const atualizado = f.state.documentos.get("agendamentos/original");
  assert.equal(resultado.reagendado, true);
  assert.equal(atualizado.status, "reagendado");
  assert.equal(atualizado.calendarEventId, "evt_original");
  assert.equal(atualizado.data, DATA);
});

test("reagendamento não ocupa horário PIX pendente nem altera o documento", async () => {
  const f = criarFixture({ isenta: false, reservas: [{ data: DATA, inicio: 840, fim: 900, estado: "reservada" }], documentos: {
    "agendamentos/original": { clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60, status: "confirmado", calendarEventId: "evt_original" },
  } });
  await assert.rejects(reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  }), (erro) => erro.codigo === "HORARIO_RESERVADO_PIX");
  assert.equal(f.state.documentos.get("agendamentos/original").data, "2026-11-03");
});

test("reagendamento recusa operação de alteração de serviço já pendente", async () => {
  const f = criarFixture({ isenta: false, documentos: {
    "agendamentos/original": {
      clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60,
      status: "confirmado", calendarEventId: "evt_original",
      alteracaoServicoOperacaoPendente: "op-andamento",
    },
  } });
  await assert.rejects(reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  }), (erro) => erro.status === 409 && erro.codigo === "ALTERACAO_SERVICO_EM_ANDAMENTO");
  assert.equal(f.state.reservas.length, 0);
  assert.equal(f.state.documentos.get("agendamentos/original").data, "2026-11-03");
});

test("reagendamento revalida marcador concorrente dentro da transação Firestore", async () => {
  const f = criarFixture({ isenta: false, marcarPendenteAntesTransacao: true, documentos: {
    "agendamentos/original": {
      clienteId: UID, data: "2026-11-03", horario: "13:00", duracao: 60,
      status: "confirmado", calendarEventId: "evt_original",
    },
  } });
  await assert.rejects(reagendarComBloqueio({
    pool: f.pool, db: f.firestore, uid: UID,
    dados: { agendamentoId: "original", servicoId: "s1", data: DATA, horario: "14:00" },
    dependencies: f.dependencies,
  }), (erro) => erro.status === 409 && erro.codigo === "ALTERACAO_SERVICO_EM_ANDAMENTO");
  assert.equal(f.state.reservas.length, 0);
  assert.equal(f.state.documentos.get("agendamentos/original").data, "2026-11-03");
});

test("agendamento isento gera notificações push para cliente e administradora", () => {
  const eventos = identificarNotificacoesAgendamento(null, {
    id: "isento-1", clienteId: UID, status: "confirmado", data: DATA,
    horario: "13:00", servico: "Manicure", nomeCliente: "Cliente Um",
    origemPagamento: "isencao_sinal_pix",
  });
  assert.deepEqual(eventos.map((evento) => evento.destinatario), ["cliente", "admin"]);
  assert.equal(eventos[0].tipo, "confirmacao_isencao_cliente");
  assert.match(eventos[0].mensagem, /pagar sinal PIX/);
});

test("isenta agenda serviço exatamente após outro confirmado da mesma conta", async () => {
  const f = criarFixture({ reservas: [{
    data: DATA, inicio: 840, fim: 900, estado: "confirmada",
    clienteUid: UID, agendamentoId: "anterior", cobrancaId: null,
  }], documentos: {
    "agendamentos/anterior": {
      clienteId: UID, data: DATA, horario: "14:00", duracao: 60, status: "confirmado",
    },
  } });
  const resultado = await criarAgendamentoIsento({
    pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "15:00"),
    dependencies: f.dependencies,
  });
  assert.equal(resultado.agendamentoConfirmado, true);
  assert.equal(f.state.documentos.get("agendamentos/anterior").horario, "14:00");
  assert.equal(f.state.reservas.length, 2);
});

test("isenta pode iniciar exatamente no término de reserva de qualquer estado ou cliente", async () => {
  for (const reserva of [
    { clienteUid: "outra", estado: "confirmada" },
    { clienteUid: UID, estado: "reservada" },
  ]) {
    const f = criarFixture({ reservas: [{
      data: DATA, inicio: 840, fim: 900, agendamentoId: "anterior", ...reserva,
    }] });
    const resultado = await criarAgendamentoIsento({
      pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "15:00"),
      dependencies: f.dependencies,
    });
    assert.equal(resultado.agendamentoConfirmado, true);
  }
});

test("isenta não permite sobreposição mesmo entre serviços da mesma cliente", async () => {
  const f = criarFixture({ reservas: [{
    data: DATA, inicio: 840, fim: 900, estado: "confirmada",
    clienteUid: UID, agendamentoId: "anterior",
  }], documentos: {
    "agendamentos/anterior": {
      clienteId: UID, data: DATA, horario: "14:00", duracao: 60, status: "confirmado",
    },
  } });
  await assert.rejects(criarAgendamentoIsento({
    pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "14:45"),
    dependencies: f.dependencies,
  }), (erro) => ["HORARIO_RESERVADO_PIX", "HORARIO_OCUPADO", "ENCAIXE_INDISPONIVEL"].includes(erro.codigo));
});

test("reserva sem vínculo não bloqueia o horário iniciado no término exato", async () => {
  const f = criarFixture({ reservas: [{
    data: DATA, inicio: 840, fim: 900, estado: "confirmada",
    clienteUid: UID, agendamentoId: null,
  }] });
  const resultado = await criarAgendamentoIsento({
    pool: f.pool, db: f.firestore, uid: UID, dados: payload(CHAVE, "15:00"),
    dependencies: f.dependencies,
  });
  assert.equal(resultado.agendamentoConfirmado, true);
});
