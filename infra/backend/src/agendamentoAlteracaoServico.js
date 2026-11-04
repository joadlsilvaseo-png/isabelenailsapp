import { randomUUID } from "node:crypto";
import { verificarUsuario } from "./pushSubscriptions.js";
import { obterDuracaoAgendamentoPix, encontrarConflitoAgendamentoPix } from "./pixDocumentoAgendamento.js";
import { converterPrecoServicoCentavos } from "./pixSinalServico.js";
import { possuiBloqueio } from "./agendaBloqueios.js";
import { STATUS_ALTERAVEIS_SERVICO, calcularRestanteServicoCentavos, validarNovoPeriodoServico } from "./agendamentoAlteracaoServicoRegras.mjs";

const URL_APPS_SCRIPT = "https://script.google.com/macros/s/AKfycbzOxH8NT960XH0HSmuq5MPDzXkijMVVymGAWD_8_eFcNzfTKfadnnoy-plj_GCtPCnFcw/exec";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ATIVOS = STATUS_ALTERAVEIS_SERVICO;
const ERRO_LIMPEZA_MARCADOR = "LIMPEZA_MARCADOR_FIRESTORE_PENDENTE";

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

function montarPayloadAtualizacaoCalendar(operacao) {
  return {
    acao: "ATUALIZAR",
    eventId: operacao.calendar_event_id,
    operationId: operacao.operation_id,
    nomeCliente: operacao.nome_cliente,
    servico: operacao.novo_servico_nome,
    dataInicio: `${operacao.data_servico}T${formatarHorario(Number(operacao.inicio_minuto))}:00`,
    duracaoMinutos: Number(operacao.duracao_nova),
  };
}

export async function enviarAtualizacaoCalendar(operacao, fetcher = fetch) {
  const payload = montarPayloadAtualizacaoCalendar(operacao);
  const resposta = await fetcher(URL_APPS_SCRIPT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!resposta.ok) throw new ErroAlteracaoServico(502, "Google Calendar não confirmou a atualização do evento.", false);
  const texto = await resposta.text();
  let corpo;
  try { corpo = JSON.parse(texto); } catch { corpo = null; }
  if (corpo?.ok === true && corpo.updated !== true) {
    throw new ErroAlteracaoServico(409, "O Apps Script ainda não confirmou suporte à atualização de evento existente.");
  }
  if (corpo?.ok !== true || corpo.updated !== true || corpo.eventId !== payload.eventId) {
    throw new ErroAlteracaoServico(409, "O Apps Script não confirmou a atualização do mesmo evento; nenhuma alteração local foi aplicada.");
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
      reserva: reservaResult.rows[0] || null,
      periodo: validarNovoPeriodoServico({ data, horario: formatarHorario(inicio), duracao: duracaoNova, servico: servicoNovo, now: dependencies.now }),
    };
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
           c.estado AS cobranca_estado, c.valor_sinal_centavos,
           c.agendamento_id AS cobranca_agendamento_id
    FROM public.pix_reservas r
    LEFT JOIN public.pix_cobrancas c ON c.id = r.cobranca_id
    WHERE r.agendamento_id = $1
  `, [operacao.agendamento_id]);
  const reserva = reservaResult.rows[0] || null;
  const possuiPix = Boolean(atual.pixCobrancaId || atual.pixPagamentoId);
  const servicoAnteriorNome = String(atual.servico || "Serviço anterior").slice(0, 120);
  const servicoAnteriorId = String(atual.idServico || atual.servicoId || "");
  if (possuiPix && (!reserva || reserva.cobranca_id !== atual.pixCobrancaId ||
      reserva.reserva_estado !== "confirmada" || reserva.cobranca_estado !== "paga" ||
      reserva.cobranca_agendamento_id !== operacao.agendamento_id)) {
    throw new ErroAlteracaoServico(409, "O vínculo entre pagamento PIX, reserva e agendamento precisa de conciliação antes da alteração.");
  }
  if (reserva && (reserva.cliente_uid !== atual.clienteId || reserva.reserva_estado !== "confirmada")) {
    throw new ErroAlteracaoServico(409, "A reserva vinculada está divergente e precisa de revisão.");
  }
  if (reserva && (reserva.reserva_data !== data || Number(reserva.reserva_inicio) !== inicio ||
      Number(reserva.reserva_fim) - Number(reserva.reserva_inicio) !== duracaoAnterior ||
      (servicoAnteriorId && reserva.reserva_servico_id !== servicoAnteriorId))) {
    throw new ErroAlteracaoServico(409, "O período ou serviço da reserva não corresponde ao agendamento; a alteração foi bloqueada.");
  }
  const sinalPagoCentavos = possuiPix ? Number(reserva.valor_sinal_centavos) : 0;
  if (!Number.isSafeInteger(sinalPagoCentavos) || sinalPagoCentavos < 0) throw new ErroAlteracaoServico(409, "O valor do sinal conciliado é inválido.");
  let precoAnteriorCentavos = 0;
  try { precoAnteriorCentavos = converterPrecoServicoCentavos(atual.precoSnapshot ?? atual.valor ?? atual.preco); }
  catch { /* Agendamentos antigos podem não ter snapshot de preço. */ }
  const snapshot = {
    clienteUid: atual.clienteId,
    nomeCliente: String(atual.nomeCliente || "Cliente").slice(0, 120),
    data, horario, inicio, eventId,
    servicoAnteriorId, servicoAnteriorNome,
    duracaoAnterior, precoAnteriorCentavos,
    servicoNovoNome: String(servicoNovo.nome || servicoNovo.nomeServico || "Serviço").slice(0, 120),
    duracaoNova, precoNovoCentavos, sinalPagoCentavos,
        restanteNovoCentavos: calcularRestanteServicoCentavos(precoNovoCentavos, sinalPagoCentavos),
    possuiPix,
    reserva,
    servicoNovo,
    atual,
    referencia,
    periodo,
  };
  await gravarSnapshotOperacao(pool, operacao.operation_id, snapshot);
  return { ...snapshot, jaAplicadaNoFirestore: false };
}

async function processarOperacao(pool, operationId, dependencies = {}) {
  const db = dependencies.firestore || await firestorePadrao();
  const fetcher = dependencies.fetch || fetch;
  const operacaoResult = await pool.query(
    "SELECT * FROM public.agendamento_alteracoes_servico WHERE operation_id = $1",
    [operationId],
  );
  const operacao = operacaoResult.rows[0];
  if (!operacao) throw new ErroAlteracaoServico(404, "Operação não encontrada.");
  if (operacao.estado === "concluida") return { estado: "concluida", operationId };
  if (operacao.estado === "falha_permanente") return { estado: "falha_permanente", operationId, erro: operacao.ultimo_erro };
  if (!(await verificarAdmin(db, operacao.admin_uid))) throw new ErroAlteracaoServico(403, "Acesso administrativo negado.");

  const snapshot = await prepararSnapshot({ pool, db, operacao, dependencies });
  if (!snapshot.periodo?.valido) throw new ErroAlteracaoServico(409, "O novo período deixou de ser permitido.");
  const conexao = await pool.connect();
  let alteracaoFirestoreFeita = false;
  let marcadorPendenteSet = false;
  const { FieldValue } = dependencies.FieldValue ? { FieldValue: dependencies.FieldValue } : await fieldValuePadrao();
  try {
    await conexao.query("BEGIN");
    await conexao.query("SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))", [snapshot.data]);
    await conexao.query("SELECT operation_id FROM public.agendamento_alteracoes_servico WHERE operation_id = $1 FOR UPDATE", [operationId]);

    const bloqueado = await (dependencies.possuiBloqueio || possuiBloqueio)(conexao, snapshot.data, snapshot.inicio, snapshot.inicio + snapshot.duracaoNova);
    if (bloqueado) throw new ErroAlteracaoServico(409, "O novo período contém um bloqueio administrativo.");
    const conflito = await conexao.query(`
      SELECT 1 FROM public.pix_reservas
      WHERE data_servico = $1 AND estado IN ('reservada', 'confirmada')
        AND agendamento_id IS DISTINCT FROM $2
        AND int4range(inicio_minuto, fim_minuto, '[)') && int4range($3, $4, '[)')
      LIMIT 1
    `, [snapshot.data, operacao.agendamento_id, snapshot.inicio, snapshot.inicio + snapshot.duracaoNova]);
    if (conflito.rowCount) throw new ErroAlteracaoServico(409, "O novo período conflita com outra reserva PIX.");

    const diaDisponibilidade = await db.collection("agendamentos").where("data", "==", snapshot.data).get();
    const outrosAgendamentos = diaDisponibilidade.docs
      .filter((doc) => doc.id !== operacao.agendamento_id)
      .map((doc) => doc.data());
    if (encontrarConflitoAgendamentoPix(outrosAgendamentos, snapshot.inicio, snapshot.inicio + snapshot.duracaoNova)) {
      throw new ErroAlteracaoServico(409, "O novo período conflita com outro agendamento confirmado.");
    }

    const documentoAtual = await db.collection("agendamentos").doc(operacao.agendamento_id).get();
    if (!documentoAtual.exists) throw new ErroAlteracaoServico(404, "Agendamento não encontrado.");
    const dadosAtualizados = documentoAtual.data();
    if (dadosAtualizados.alteracaoServicoOperacaoId !== operationId &&
        (!ATIVOS.has(String(dadosAtualizados.status || "")) ||
         String(dadosAtualizados.idServico || dadosAtualizados.servicoId || "") !== snapshot.servicoAnteriorId ||
         dadosPeriodo(dadosAtualizados).data !== snapshot.data ||
         dadosPeriodo(dadosAtualizados).inicio !== snapshot.inicio)) {
      throw new ErroAlteracaoServico(409, "O agendamento mudou enquanto a alteração era preparada.");
    }

    if (!snapshot.jaAplicadaNoFirestore) {
      await db.runTransaction(async (transacao) => {
        const perfilRef = db.collection("usuarios").doc(operacao.admin_uid);
        const referencia = db.collection("agendamentos").doc(operacao.agendamento_id);
        const [perfilSnap, agendamentoSnap] = await Promise.all([
          transacao.get(perfilRef), transacao.get(referencia),
        ]);
        if (!perfilSnap.exists || perfilSnap.data()?.role !== "admin" || perfilSnap.data()?.ativo !== true) {
          throw new ErroAlteracaoServico(403, "Acesso administrativo negado.");
        }
        if (!agendamentoSnap.exists) throw new ErroAlteracaoServico(404, "Agendamento não encontrado.");
        const atual = agendamentoSnap.data();
        if (!ATIVOS.has(String(atual.status || ""))) throw new ErroAlteracaoServico(409, "O agendamento deixou de estar ativo.");
        if (atual.alteracaoServicoOperacaoId === operationId) return;
        if (atual.alteracaoServicoOperacaoPendente && atual.alteracaoServicoOperacaoPendente !== operationId) {
          throw new ErroAlteracaoServico(409, "Outra alteração deste atendimento ainda está sendo processada.");
        }
        const periodoAtual = dadosPeriodo(atual);
        if (periodoAtual.data !== snapshot.data || periodoAtual.inicio !== snapshot.inicio ||
            String(atual.idServico || atual.servicoId || "") !== snapshot.servicoAnteriorId) {
          throw new ErroAlteracaoServico(409, "O agendamento mudou enquanto a alteração era preparada.");
        }
        const dia = await transacao.get(db.collection("agendamentos").where("data", "==", snapshot.data));
        const registros = dia.docs.filter((doc) => doc.id !== operacao.agendamento_id).map((doc) => doc.data());
        if (encontrarConflitoAgendamentoPix(registros, snapshot.inicio, snapshot.inicio + snapshot.duracaoNova)) {
          throw new ErroAlteracaoServico(409, "O novo período conflita com outro agendamento confirmado.");
        }
        transacao.update(referencia, { alteracaoServicoOperacaoPendente: operationId });
        marcadorPendenteSet = true;
      });
    }

    // Sincronize a reserva no mesmo PostgreSQL transaction antes de qualquer
    // side effect externo ou atualização final no Firestore. Constraints de
    // sobreposição continuam sendo a última barreira contra corrida.
    if (snapshot.reserva) {
      const atualizada = await conexao.query(`
        UPDATE public.pix_reservas
        SET servico_id = $2, fim_minuto = $3, atualizado_em = NOW()
        WHERE id = $1 AND agendamento_id = $4 AND cliente_uid = $5
          AND estado = 'confirmada'
      `, [snapshot.reserva.reserva_id, operacao.servico_novo_id,
        snapshot.inicio + snapshot.duracaoNova, operacao.agendamento_id, snapshot.clienteUid]);
      if (atualizada.rowCount !== 1) throw new ErroAlteracaoServico(409, "A reserva mudou durante a alteração.");
    } else {
      await conexao.query(`
        INSERT INTO public.pix_reservas (
          cliente_uid, servico_id, data_servico, inicio_minuto, fim_minuto,
          estado, vence_em, cobranca_id, agendamento_id
        ) VALUES ($1, $2, $3, $4, $5, 'confirmada', NOW(), NULL, $6)
      `, [snapshot.clienteUid, operacao.servico_novo_id, snapshot.data,
        snapshot.inicio, snapshot.inicio + snapshot.duracaoNova, operacao.agendamento_id]);
    }

    const confirmarCalendar = dependencies.enviarCalendar || enviarAtualizacaoCalendar;
    await confirmarCalendar({
      ...operacao,
      data_servico: snapshot.data,
      inicio_minuto: snapshot.inicio,
      calendar_event_id: snapshot.eventId,
      nome_cliente: snapshot.nomeCliente,
      novo_servico_nome: snapshot.servicoNovoNome,
      duracao_nova: snapshot.duracaoNova,
    }, fetcher);

    if (!snapshot.jaAplicadaNoFirestore) {
      await db.runTransaction(async (transacao) => {
        const perfilRef = db.collection("usuarios").doc(operacao.admin_uid);
        const referencia = db.collection("agendamentos").doc(operacao.agendamento_id);
        const [perfilSnap, agendamentoSnap] = await Promise.all([
          transacao.get(perfilRef), transacao.get(referencia),
        ]);
        if (!perfilSnap.exists || perfilSnap.data()?.role !== "admin" || perfilSnap.data()?.ativo !== true) {
          throw new ErroAlteracaoServico(403, "Acesso administrativo negado.");
        }
        if (!agendamentoSnap.exists) throw new ErroAlteracaoServico(404, "Agendamento não encontrado.");
        const atual = agendamentoSnap.data();
        if (atual.alteracaoServicoOperacaoId === operationId) return;
        if (atual.alteracaoServicoOperacaoPendente !== operationId) {
          throw new ErroAlteracaoServico(409, "A operação perdeu seu marcador de segurança.");
        }
        if (!ATIVOS.has(String(atual.status || ""))) throw new ErroAlteracaoServico(409, "O agendamento deixou de estar ativo.");
        const periodoAtual = dadosPeriodo(atual);
        if (periodoAtual.data !== snapshot.data || periodoAtual.inicio !== snapshot.inicio ||
            String(atual.idServico || atual.servicoId || "") !== snapshot.servicoAnteriorId) {
          throw new ErroAlteracaoServico(409, "O agendamento mudou enquanto a alteração era preparada.");
        }
        const dia = await transacao.get(db.collection("agendamentos").where("data", "==", snapshot.data));
        const registros = dia.docs.filter((doc) => doc.id !== operacao.agendamento_id).map((doc) => doc.data());
        if (encontrarConflitoAgendamentoPix(registros, snapshot.inicio, snapshot.inicio + snapshot.duracaoNova)) {
          throw new ErroAlteracaoServico(409, "O novo período conflita com outro agendamento confirmado.");
        }
        transacao.update(referencia, {
          servico: snapshot.servicoNovoNome,
          idServico: operacao.servico_novo_id,
          duracao: snapshot.duracaoNova,
          duracaoSnapshot: snapshot.duracaoNova,
          precoSnapshot: snapshot.precoNovoCentavos / 100,
          valorRestanteCentavos: snapshot.restanteNovoCentavos,
          alteracaoServicoOperacaoId: operationId,
          // O marcador só sai após o COMMIT PostgreSQL ter sido confirmado.
          alteracaoServicoAtualizadaEm: FieldValue.serverTimestamp(),
          alteracaoServicoAtualizadaPor: operacao.admin_uid,
          atualizadoEm: FieldValue.serverTimestamp(),
          atualizadoPor: operacao.admin_uid,
        });
        const historicoRef = referencia.collection("alteracoes_servico").doc(operationId);
        transacao.create(historicoRef, {
          agendamentoId: operacao.agendamento_id,
          administradoraUid: operacao.admin_uid,
          servicoAnteriorId: snapshot.servicoAnteriorId,
          servicoAnterior: snapshot.servicoAnteriorNome,
          servicoNovoId: operacao.servico_novo_id,
          servicoNovo: snapshot.servicoNovoNome,
          duracaoAnterior: snapshot.duracaoAnterior,
          duracaoNova: snapshot.duracaoNova,
          precoAnteriorCentavos: snapshot.precoAnteriorCentavos,
          precoNovoCentavos: snapshot.precoNovoCentavos,
          sinalPagoCentavos: snapshot.sinalPagoCentavos,
          calendarEventId: snapshot.eventId,
          sincronizacaoCalendar: "confirmada",
          criadaEm: FieldValue.serverTimestamp(),
        });
        alteracaoFirestoreFeita = true;
      });
    }

    await conexao.query(`
      UPDATE public.agendamento_alteracoes_servico
      SET estado = 'concluida', calendar_estado = 'enviado', concluido_em = NOW(),
          atualizado_em = NOW(), ultimo_erro = NULL, bloqueado_ate = NULL
      WHERE operation_id = $1
    `, [operationId]);
    await conexao.query("COMMIT");
    // PostgreSQL é a barreira de publicação do período. Até o commit, o marcador
    // Firestore mantém bloqueados reagendamentos, conclusões e cancelamentos.
    // A limpeza pós-commit é idempotente e reprocessada pelo worker se falhar.
    try {
      await limparMarcadorPendente(db, operacao, operationId, FieldValue);
    } catch (erroLimpeza) {
      console.error("[Alteração serviço] Marcador pós-commit pendente:", erroLimpeza.message);
      await pool.query(`
        UPDATE public.agendamento_alteracoes_servico
        SET ultimo_erro = $2, proxima_tentativa_em = NOW() + INTERVAL '30 seconds',
            bloqueado_ate = NULL, atualizado_em = NOW()
        WHERE operation_id = $1 AND estado = 'concluida'
      `, [operationId, ERRO_LIMPEZA_MARCADOR]).catch((erroDb) => {
        console.error("[Alteração serviço] Agendamento concluído requer limpeza manual do marcador:", erroDb.message);
      });
    }
    return { estado: "concluida", operationId, servico: snapshot.servicoNovoNome,
      duracao: snapshot.duracaoNova, precoCentavos: snapshot.precoNovoCentavos,
      sinalPagoCentavos: snapshot.sinalPagoCentavos, restanteCentavos: snapshot.restanteNovoCentavos };
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    const permanente = erro instanceof ErroAlteracaoServico && erro.permanente && !snapshot.jaAplicadaNoFirestore;
    const erroResposta = erro instanceof ErroAlteracaoServico && erro.permanente && snapshot.jaAplicadaNoFirestore
      ? new ErroAlteracaoServico(503, "A sincronização do evento continua pendente e será retomada automaticamente.", false)
      : erro;
    if (permanente && marcadorPendenteSet) {
      await limparMarcadorPendente(db, operacao, operationId, FieldValue).catch((compensacao) => {
        console.error("[Alteração serviço] Marcador pendente precisa de recuperação:", compensacao.message);
      });
    }
    await pool.query(`
      UPDATE public.agendamento_alteracoes_servico
      SET estado = CASE WHEN $2 THEN 'falha_permanente' ELSE 'solicitada' END,
          calendar_estado = CASE WHEN $2 THEN 'falha' ELSE 'pendente' END,
          tentativas = tentativas + 1, bloqueado_ate = NULL,
          proxima_tentativa_em = NOW() + CASE WHEN $2 THEN INTERVAL '100 years' ELSE INTERVAL '30 seconds' END,
          ultimo_erro = $3, atualizado_em = NOW()
      WHERE operation_id = $1 AND estado <> 'concluida'
    `, [operationId, permanente, String(erroResposta?.message || "Falha temporária").slice(0, 300)]).catch(() => {});
    if (alteracaoFirestoreFeita) {
      console.error("[Alteração serviço] Dados Firestore gravados; operação será retomada pela fila.");
    }
    throw erroResposta;
  } finally {
    conexao.release();
  }
}

export async function atenderAlteracaoServico(req, res, pool, dependencies = {}) {
  let uid;
  try { uid = await (dependencies.verificarUsuario || verificarUsuario)(req); }
  catch { responder(res, 401, { erro: "Não autenticado." }); return; }
  const db = dependencies.firestore || await firestorePadrao();
  if (!(await verificarAdmin(db, uid))) { responder(res, 403, { erro: "Acesso administrativo negado." }); return; }
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET") {
    const operationId = url.searchParams.get("operationId");
    if (!UUID.test(operationId || "")) { responder(res, 400, { erro: "Operação inválida." }); return; }
    try {
      const result = await pool.query(`
        SELECT operation_id, estado, calendar_estado, ultimo_erro,
               servico_novo_nome, duracao_nova, preco_novo_centavos,
               sinal_pago_centavos, restante_novo_centavos
        FROM public.agendamento_alteracoes_servico
        WHERE operation_id = $1 AND admin_uid = $2
      `, [operationId, uid]);
      if (!result.rowCount) { responder(res, 404, { erro: "Operação não encontrada." }); return; }
      responder(res, 200, result.rows[0]);
    } catch (erro) {
      console.error("[Alteração serviço] Consulta indisponível:", erro.message);
      responder(res, 503, { erro: "Não foi possível consultar a alteração." });
    }
    return;
  }

  if (req.method !== "PATCH") { responder(res, 405, { erro: "Método não permitido." }); return; }
  let operationIdFalha = null;
  try {
    const dados = await lerJson(req);
    if (!ID.test(dados.agendamentoId || "") || !ID.test(dados.servicoId || "") || !UUID.test(dados.operationId || "")) {
      throw new ErroAlteracaoServico(400, "Dados da alteração inválidos.");
    }
    await pool.query(`
      INSERT INTO public.agendamento_alteracoes_servico (
        operation_id, agendamento_id, admin_uid, servico_novo_id
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (operation_id) DO NOTHING
    `, [dados.operationId, dados.agendamentoId, uid, dados.servicoId]);
    const existentes = await pool.query(
      "SELECT * FROM public.agendamento_alteracoes_servico WHERE operation_id = $1",
      [dados.operationId],
    );
    const operacao = existentes.rows[0];
    if (operacao.agendamento_id !== dados.agendamentoId || operacao.admin_uid !== uid || operacao.servico_novo_id !== dados.servicoId) {
      throw new ErroAlteracaoServico(409, "Esta chave de operação já foi usada para outra alteração.");
    }
    // Somente a operação já validada pode mudar para falha permanente.
    // Uma chave UUID reutilizada indevidamente nunca pode invalidar a operação original.
    operationIdFalha = dados.operationId;
    if (operacao.estado === "concluida") { responder(res, 200, { operationId: dados.operationId, estado: "concluida" }); return; }
    if (operacao.estado === "falha_permanente") { throw new ErroAlteracaoServico(409, operacao.ultimo_erro || "A alteração requer revisão."); }
    try {
      const resultado = await processarOperacao(pool, dados.operationId, { ...dependencies, firestore: db });
      responder(res, 200, resultado);
    } catch (erro) {
      const latest = await pool.query("SELECT estado, ultimo_erro FROM public.agendamento_alteracoes_servico WHERE operation_id = $1", [dados.operationId]).catch(() => ({ rows: [] }));
      if (erro instanceof ErroAlteracaoServico && erro.permanente) throw erro;
      responder(res, 202, { operationId: dados.operationId, estado: latest.rows[0]?.estado || "solicitada", sincronizacaoCalendar: "pendente" });
    }
  } catch (erro) {
    const status = erro instanceof ErroAlteracaoServico ? erro.status : 500;
    if (status >= 400 && status < 500) {
      if (UUID.test(operationIdFalha || "")) {
        await pool.query(`
          UPDATE public.agendamento_alteracoes_servico
          SET estado = 'falha_permanente', calendar_estado = 'falha',
              ultimo_erro = $2, bloqueado_ate = NULL, atualizado_em = NOW()
          WHERE operation_id = $1 AND estado <> 'concluida'
        `, [operationIdFalha, String(erro.message).slice(0, 300)]).catch(() => {});
      }
    }
    if (status >= 500) console.error("[Alteração serviço] Falha:", erro.message);
    responder(res, status, { erro: status === 500 ? "Não foi possível alterar o serviço." : erro.message });
  }
}

export async function processarProximaAlteracaoServico(pool, dependencies = {}) {
  const claimed = await pool.query(`
    WITH proxima AS (
      SELECT operation_id FROM public.agendamento_alteracoes_servico
      WHERE (estado = 'solicitada' OR (estado = 'concluida' AND ultimo_erro = $1))
        AND proxima_tentativa_em <= NOW()
        AND (bloqueado_ate IS NULL OR bloqueado_ate <= NOW())
      ORDER BY criado_em FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE public.agendamento_alteracoes_servico AS fila
    SET bloqueado_ate = NOW() + INTERVAL '2 minutes', atualizado_em = NOW()
    FROM proxima WHERE fila.operation_id = proxima.operation_id
    RETURNING fila.operation_id, fila.estado
  `, [ERRO_LIMPEZA_MARCADOR]);
  const operationId = claimed.rows[0]?.operation_id;
  if (!operationId) return { processado: false };
  const limpezaConcluidaPendente = claimed.rows[0].estado === "concluida";
  try {
    if (limpezaConcluidaPendente) {
      const result = await pool.query(
        "SELECT * FROM public.agendamento_alteracoes_servico WHERE operation_id = $1",
        [operationId],
      );
      const operacao = result.rows[0];
      if (!operacao) throw new Error("Operação de limpeza não encontrada");
      const db = dependencies.firestore || await firestorePadrao();
      const FieldValue = dependencies.FieldValue || await fieldValuePadrao();
      await limparMarcadorPendente(db, operacao, operationId, FieldValue);
      await pool.query(`
        UPDATE public.agendamento_alteracoes_servico
        SET ultimo_erro = NULL, bloqueado_ate = NULL, atualizado_em = NOW()
        WHERE operation_id = $1 AND estado = 'concluida' AND ultimo_erro = $2
      `, [operationId, ERRO_LIMPEZA_MARCADOR]);
      return { processado: true, estado: "concluida", marcadorLiberado: true };
    }
    const resultado = await processarOperacao(pool, operationId, dependencies);
    return { processado: true, ...resultado };
  } catch (erro) {
    if (limpezaConcluidaPendente) {
      console.error("[Alteração serviço] Falha ao liberar marcador pós-commit:", erro.message);
      await pool.query(`
        UPDATE public.agendamento_alteracoes_servico
        SET bloqueado_ate = NULL, proxima_tentativa_em = NOW() + INTERVAL '60 seconds',
            atualizado_em = NOW()
        WHERE operation_id = $1 AND estado = 'concluida'
      `, [operationId]);
      return { processado: true, estado: "concluida", marcadorLiberado: false };
    }
    const retry = !(erro instanceof ErroAlteracaoServico && erro.permanente);
    await pool.query(`
      UPDATE public.agendamento_alteracoes_servico
      SET estado = CASE WHEN $2 THEN 'solicitada' ELSE 'falha_permanente' END,
          calendar_estado = CASE WHEN $2 THEN 'pendente' ELSE 'falha' END,
          bloqueado_ate = NULL,
          proxima_tentativa_em = NOW() + CASE WHEN $2 THEN INTERVAL '60 seconds' ELSE INTERVAL '100 years' END,
          ultimo_erro = $3, atualizado_em = NOW()
      WHERE operation_id = $1 AND estado <> 'concluida'
    `, [operationId, retry, String(erro?.message || "Falha").slice(0, 300)]);
    return { processado: true, estado: retry ? "solicitada" : "falha_permanente" };
  }
}

export function iniciarWorkerAlteracaoServico(pool, dependencies = {}) {
  let ocupado = false;
  const executar = async () => {
    if (ocupado) return;
    ocupado = true;
    try { await processarProximaAlteracaoServico(pool, dependencies); }
    catch (erro) { console.error("[Alteração serviço] Worker indisponível:", erro.message); }
    finally { ocupado = false; }
  };
  const timer = setInterval(executar, 10000);
  timer.unref?.();
  executar();
  return () => clearInterval(timer);
}

export { montarPayloadAtualizacaoCalendar };
