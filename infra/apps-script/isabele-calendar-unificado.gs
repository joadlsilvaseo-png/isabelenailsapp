/**
 * ISABELE MARIANA NAILS — CALENDAR UNIFICADO
 * Fase 2: código preparado e NÃO implantado.
 * A implantação e a substituição das URLs exigem primeiro a API compatível
 * (fases seguintes). NÃO colar/publicar este script isoladamente em produção.
 *
 * Requer Script Properties:
 *   ISABELE_CALENDAR_ID       = ID explícito do calendário de atendimentos
 *   ISABELE_INTEGRACAO_TOKEN  = segredo aleatório >= 32 caracteres
 *
 * Contrato: JSON POST com acao, eventId, operationId, integracaoToken
 * e campos específicos. Respostas sempre JSON, incluindo falhas de aplicação.
 */
var ISABELE_TZ = "America/Sao_Paulo";
var CHAVE_VINCULO_NOVO = "reserva_";
var CHAVE_VINCULO_LEGADO = "isabele_evento_";
var CHAVE_CANCELADO = "isabele_cancelado_";
var TAG_RESERVA = "idReserva";
var TAG_OPERACAO = "isabeleUltimaOperacaoId";
var TAG_ASSINATURA = "isabeleUltimaOperacaoHash";
var DESCRICAO_ID = "Agendamento no app: ";
var DATA_FORMATO = "yyyy-MM-dd'T'HH:mm:ss";

function respostaCalendarUnificado_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function erroCalendarUnificado_(codigo, mensagem) {
  var erro = new Error(mensagem);
  erro.codigo = codigo;
  return erro;
}

function exigirCalendar_(condicao, codigo, mensagem) {
  if (!condicao) throw erroCalendarUnificado_(codigo, mensagem);
}

function textoCalendar_(valor) {
  return String(valor == null ? "" : valor).trim();
}

function conferirTokenCalendar_(recebido, esperado) {
  if (typeof recebido !== "string" || typeof esperado !== "string" ||
      esperado.length < 32 || recebido.length !== esperado.length) return false;
  var diferente = 0;
  for (var i = 0; i < esperado.length; i++) {
    diferente |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  }
  return diferente === 0;
}

function validarIdentificadoresCalendar_(dados) {
  var id = textoCalendar_(dados.eventId);
  var operacao = textoCalendar_(dados.operationId);
  exigirCalendar_(/^[A-Za-z0-9_-]{1,160}$/.test(id),
    "EVENT_ID_INVALIDO", "Identificador do agendamento inválido.");
  exigirCalendar_(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operacao),
    "OPERACAO_INVALIDA", "Identificador da operação inválido.");
  return { id: id, operacao: operacao };
}

function instanteCalendar_(valor) {
  var entrada = textoCalendar_(valor);
  var padraoLocal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  var padraoFuso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
  exigirCalendar_(padraoLocal.test(entrada) || padraoFuso.test(entrada),
    "DATA_INVALIDA", "Formato de data/hora inválido.");
  var data = padraoLocal.test(entrada)
    ? Utilities.parseDate(entrada, ISABELE_TZ, DATA_FORMATO)
    : new Date(entrada);
  exigirCalendar_(data instanceof Date && Number.isFinite(data.getTime()),
    "DATA_INVALIDA", "Data/hora inválida.");
  if (padraoLocal.test(entrada)) {
    exigirCalendar_(Utilities.formatDate(data, ISABELE_TZ, DATA_FORMATO) === entrada,
      "DATA_INVALIDA", "Data/hora inexistente no fuso de São Paulo.");
  }
  return data;
}

function duracaoCalendar_(valor) {
  var numero = Number(valor);
  exigirCalendar_(valor !== null && valor !== undefined && valor !== "" &&
      Number.isInteger(numero) && numero >= 1 && numero <= 600,
    "DURACAO_INVALIDA", "Duração inválida: deve ser de 1 a 600 minutos.");
  return numero;
}

function tituloCalendar_(dados) {
  var cliente = textoCalendar_(dados.nomeCliente);
  var servico = textoCalendar_(dados.servico);
  exigirCalendar_(cliente.length > 0 && servico.length > 0 &&
      cliente.length <= 120 && servico.length <= 120,
    "TITULO_INVALIDO", "Cliente e serviço são obrigatórios.");
  return servico + " - " + cliente;
}

function fimCalendar_(inicio, duracao) {
  return new Date(inicio.getTime() + duracao * 60000);
}

function hashCalendar_(valor) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, valor, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ("0" + (b & 255).toString(16)).slice(-2);
  }).join("");
}

function assinaturaCalendar_(dados, acao, id) {
  return hashCalendar_(JSON.stringify([
    acao, id,
    textoCalendar_(dados.nomeCliente),
    textoCalendar_(dados.servico),
    textoCalendar_(dados.dataInicio),
    Number(dados.duracaoMinutos || 0),
    textoCalendar_(dados.origemDataInicio),
    Number(dados.origemDuracaoMinutos || 0)
  ]));
}

function temIdentidadeCalendar_(evento, id) {
  var tag = textoCalendar_(evento.getTag(TAG_RESERVA));
  // Na varredura de horários, ignorar eventos de outras reservas.
  // Para um vínculo persistido, uma tag divergente é erro de integridade.
  if (tag) return tag === id;
  var descricao = textoCalendar_(evento.getDescription());
  // A descrição do legado contém um identificador interno explícito.
  // Não aceitar coincidência de nome/serviço/horário como prova de identidade.
  var linha = DESCRICAO_ID + id;
  return descricao.split(/\r?\n/).some(function (item) {
    return item.trim() === linha;
  });
}

function localizarPorInicioCalendar_(calendar, dataInicio, id) {
  if (!dataInicio) return [];
  var inicio = instanteCalendar_(dataInicio);
  var janela = calendar.getEvents(
    new Date(inicio.getTime() - 60000),
    new Date(inicio.getTime() + 60000)
  );
  return janela.filter(function (evento) {
    return Math.abs(evento.getStartTime().getTime() - inicio.getTime()) < 60000 &&
      temIdentidadeCalendar_(evento, id);
  });
}

function localizarEventoCalendar_(calendar, props, id, dados, permitirNovo) {
  var chave = CHAVE_VINCULO_NOVO + id;
  var chaveLegada = CHAVE_VINCULO_LEGADO + id;
  var vinculoNovo = props.getProperty(chave);
  var vinculoLegado = props.getProperty(chaveLegada);
  if (vinculoNovo && vinculoLegado && vinculoNovo !== vinculoLegado) {
    throw erroCalendarUnificado_("VINCULOS_DIVERGENTES",
      "Os vínculos existentes apontam para eventos diferentes.");
  }
  var idPersistido = vinculoNovo || vinculoLegado;
  // A API futura pode fornecer o Google Event ID que tiver sido validado
  // e preservado no PostgreSQL. Exigir o marcador no próprio evento.
  var idRecebido = textoCalendar_(dados.googleEventId);
  if (idRecebido) {
    exigirCalendar_(!idPersistido || idPersistido === idRecebido,
      "VINCULOS_DIVERGENTES", "O identificador persistido diverge do informado.");
    var eventoPeloId = calendar.getEventById(idRecebido);
    exigirCalendar_(Boolean(eventoPeloId) &&
        temIdentidadeCalendar_(eventoPeloId, id),
      "GOOGLE_EVENT_ID_NAO_VERIFICADO",
      "O ID Google não localiza um evento com identidade verificável.");
    return eventoPeloId;
  }
  if (idPersistido) {
    var encontrado = calendar.getEventById(idPersistido);
    exigirCalendar_(Boolean(encontrado), "VINCULO_EVENTO_AUSENTE",
      "Há vínculo salvo, mas o evento não foi localizado. Revisão necessária.");
    var tagPersistida = textoCalendar_(encontrado.getTag(TAG_RESERVA));
    exigirCalendar_(!tagPersistida || tagPersistida === id,
      "EVENTO_OUTRA_RESERVA", "O vínculo salvo aponta para outra reserva.");
    return encontrado;
  }

  // Propriedades de outro PROJETO não são visíveis aqui. Recuperar somente
  // pelo marcador de identidade no evento, usando horário original ou destino.
  var candidatos = {};
  [dados.origemDataInicio, dados.dataInicio].forEach(function (data) {
    localizarPorInicioCalendar_(calendar, data, id).forEach(function (evento) {
      candidatos[evento.getId()] = evento;
    });
  });
  var ids = Object.keys(candidatos);
  exigirCalendar_(ids.length <= 1, "EVENTO_AMBIGUO",
    "Foram encontrados múltiplos eventos com a mesma reserva.");
  if (ids.length === 1) return candidatos[ids[0]];
  if (permitirNovo) return null;
  throw erroCalendarUnificado_("EVENTO_NAO_LOCALIZADO",
    "Evento não localizado pelo identificador e pelo horário original.");
}

function registrarVinculoCalendar_(props, evento, id) {
  var tag = textoCalendar_(evento.getTag(TAG_RESERVA));
  exigirCalendar_(!tag || tag === id, "EVENTO_OUTRA_RESERVA",
    "O evento está vinculado a outra reserva.");
  if (!tag) evento.setTag(TAG_RESERVA, id);
  var descricao = textoCalendar_(evento.getDescription());
  var marcador = DESCRICAO_ID + id;
  if (!descricao.split(/\r?\n/).some(function (linha) { return linha.trim() === marcador; })) {
    evento.setDescription((descricao ? descricao + "\n" : "") + marcador);
  }
  // Somente a chave canônica cresce com eventos novos. A chave legada
  // permanece apenas para leitura de vínculos antigos já migrados.
  props.setProperty(CHAVE_VINCULO_NOVO + id, evento.getId());
}

function validarEstadoCalendar_(evento, inicio, duracao, titulo) {
  return evento &&
    evento.getStartTime().getTime() === inicio.getTime() &&
    evento.getEndTime().getTime() === fimCalendar_(inicio, duracao).getTime() &&
    evento.getTitle() === titulo;
}

function marcarOperacaoCalendar_(evento, operacao, assinatura) {
  evento.setTag(TAG_OPERACAO, operacao);
  evento.setTag(TAG_ASSINATURA, assinatura);
}

function validarRepeticaoCalendar_(evento, operacao, assinatura, inicio, duracao, titulo) {
  if (textoCalendar_(evento.getTag(TAG_OPERACAO)) !== operacao) return false;
  exigirCalendar_(textoCalendar_(evento.getTag(TAG_ASSINATURA)) === assinatura,
    "OPERACAO_REUTILIZADA", "Operação repetida com dados diferentes.");
  exigirCalendar_(validarEstadoCalendar_(evento, inicio, duracao, titulo),
    "EVENTO_DIVERGENTE", "O evento não corresponde à operação já registrada.");
  return true;
}

function respostaSucessoCalendar_(status, id, operacao, eventoId, repeated) {
  return {
    ok: true, status: status, eventId: id, operationId: operacao,
    googleEventId: eventoId || null, repeated: repeated === true
  };
}

function agendarCalendar_(calendar, props, dados, ids, assinatura) {
  exigirCalendar_(props.getProperty(CHAVE_CANCELADO + ids.id) !== "sim",
    "RESERVA_CANCELADA", "A reserva cancelada não pode ser recriada.");
  var inicio = instanteCalendar_(dados.dataInicio);
  var duracao = duracaoCalendar_(dados.duracaoMinutos);
  var titulo = tituloCalendar_(dados);
  var evento = localizarEventoCalendar_(calendar, props, ids.id, dados, true);
  if (evento) {
    exigirCalendar_(validarEstadoCalendar_(evento, inicio, duracao, titulo),
      "EVENTO_DIVERGENTE", "Já existe evento com outros dados para esta reserva.");
    registrarVinculoCalendar_(props, evento, ids.id);
    return respostaSucessoCalendar_("AGENDADO", ids.id, ids.operacao, evento.getId(), true);
  }

  evento = calendar.createEvent(titulo, inicio, fimCalendar_(inicio, duracao), {
    description: DESCRICAO_ID + ids.id
  });
  registrarVinculoCalendar_(props, evento, ids.id);
  marcarOperacaoCalendar_(evento, ids.operacao, assinatura);
  var confirmado = calendar.getEventById(evento.getId());
  exigirCalendar_(validarEstadoCalendar_(confirmado, inicio, duracao, titulo),
    "CONFIRMACAO_INDEFINIDA", "O evento foi enviado, mas a leitura de confirmação falhou.");
  return respostaSucessoCalendar_("AGENDADO", ids.id, ids.operacao, evento.getId(), false);
}

function exigirOrigemCalendar_(dados, evento) {
  // Reagendamento exige origem imutável: previne alteração de evento já movido.
  var origem = instanteCalendar_(dados.origemDataInicio);
  var duracaoOriginal = duracaoCalendar_(dados.origemDuracaoMinutos);
  exigirCalendar_(evento.getStartTime().getTime() === origem.getTime() &&
      evento.getEndTime().getTime() === fimCalendar_(origem, duracaoOriginal).getTime(),
    "ORIGEM_DIVERGENTE", "Data/duração original divergente. Revisão necessária.");
}

function reagendarCalendar_(calendar, props, dados, ids, assinatura) {
  exigirCalendar_(props.getProperty(CHAVE_CANCELADO + ids.id) !== "sim",
    "RESERVA_CANCELADA", "Não é permitido reagendar uma reserva cancelada.");
  var destino = instanteCalendar_(dados.dataInicio);
  var duracao = duracaoCalendar_(dados.duracaoMinutos);
  var titulo = tituloCalendar_(dados);
  var evento = localizarEventoCalendar_(calendar, props, ids.id, dados, false);
  if (validarRepeticaoCalendar_(evento, ids.operacao, assinatura, destino, duracao, titulo)) {
    registrarVinculoCalendar_(props, evento, ids.id);
    return respostaSucessoCalendar_("REAGENDADO", ids.id, ids.operacao, evento.getId(), true);
  }
  exigirOrigemCalendar_(dados, evento);
  evento.setTime(destino, fimCalendar_(destino, duracao));
  evento.setTitle(titulo);
  marcarOperacaoCalendar_(evento, ids.operacao, assinatura);
  registrarVinculoCalendar_(props, evento, ids.id);
  var confirmado = calendar.getEventById(evento.getId());
  exigirCalendar_(validarEstadoCalendar_(confirmado, destino, duracao, titulo),
    "CONFIRMACAO_INDEFINIDA", "Alteração enviada, mas não confirmada pela leitura.");
  return respostaSucessoCalendar_("REAGENDADO", ids.id, ids.operacao, evento.getId(), false);
}

function atualizarCalendar_(calendar, props, dados, ids, assinatura) {
  exigirCalendar_(props.getProperty(CHAVE_CANCELADO + ids.id) !== "sim",
    "RESERVA_CANCELADA", "Não é permitido atualizar reserva cancelada.");
  var inicio = instanteCalendar_(dados.dataInicio);
  var duracao = duracaoCalendar_(dados.duracaoMinutos);
  var titulo = tituloCalendar_(dados);
  var evento = localizarEventoCalendar_(calendar, props, ids.id, dados, false);
  if (validarRepeticaoCalendar_(evento, ids.operacao, assinatura, inicio, duracao, titulo)) {
    registrarVinculoCalendar_(props, evento, ids.id);
    return Object.assign(respostaSucessoCalendar_("ATUALIZADO", ids.id, ids.operacao, evento.getId(), true), { updated: true });
  }
  exigirCalendar_(evento.getStartTime().getTime() === inicio.getTime(),
    "INICIO_DIVERGENTE", "ATUALIZAR não pode modificar o início do atendimento.");
  evento.setTime(inicio, fimCalendar_(inicio, duracao));
  evento.setTitle(titulo);
  marcarOperacaoCalendar_(evento, ids.operacao, assinatura);
  registrarVinculoCalendar_(props, evento, ids.id);
  var confirmado = calendar.getEventById(evento.getId());
  exigirCalendar_(validarEstadoCalendar_(confirmado, inicio, duracao, titulo),
    "CONFIRMACAO_INDEFINIDA", "Atualização enviada, mas não confirmada pela leitura.");
  return Object.assign(respostaSucessoCalendar_("ATUALIZADO", ids.id, ids.operacao, evento.getId(), false), { updated: true });
}

function cancelarCalendar_(calendar, props, dados, ids, assinatura) {
  var chaveCancelada = CHAVE_CANCELADO + ids.id;
  var tombstone = props.getProperty(chaveCancelada);
  if (tombstone === "sim") {
    var antigoId = props.getProperty(CHAVE_VINCULO_NOVO + ids.id) ||
      props.getProperty(CHAVE_VINCULO_LEGADO + ids.id);
    exigirCalendar_(!antigoId || !calendar.getEventById(antigoId),
      "CANCELAMENTO_DIVERGENTE", "Reserva marcada como cancelada, porém o evento existe.");
    return respostaSucessoCalendar_("JA_CANCELADO", ids.id, ids.operacao, antigoId || null, true);
  }
  var evento = localizarEventoCalendar_(calendar, props, ids.id, dados, false);
  if (dados.origemDataInicio) {
    var origem = instanteCalendar_(dados.origemDataInicio);
    exigirCalendar_(evento.getStartTime().getTime() === origem.getTime(),
      "ORIGEM_DIVERGENTE", "Evento mudou de data antes do cancelamento.");
  }
  var googleId = evento.getId();
  evento.deleteEvent();
  exigirCalendar_(!calendar.getEventById(googleId), "CONFIRMACAO_INDEFINIDA",
    "Exclusão enviada, mas a ausência do evento ainda não foi confirmada.");
  props.setProperty(chaveCancelada, "sim");
  props.setProperty(CHAVE_VINCULO_NOVO + ids.id, googleId);
  return respostaSucessoCalendar_("CANCELADO", ids.id, ids.operacao, googleId, false);
}

function doPost(e) {
  var dados = null;
  var lock = null;
  var obtido = false;
  try {
    var bruto = e && e.postData && e.postData.contents;
    exigirCalendar_(typeof bruto === "string" && bruto.length <= 12000 && bruto.length > 0,
      "REQUISICAO_INVALIDA", "Corpo da requisição inválido.");
    dados = JSON.parse(bruto);
    exigirCalendar_(dados && typeof dados === "object" && !Array.isArray(dados),
      "REQUISICAO_INVALIDA", "Objeto JSON inválido.");

    var props = PropertiesService.getScriptProperties();
    exigirCalendar_(conferirTokenCalendar_(dados.integracaoToken,
        props.getProperty("ISABELE_INTEGRACAO_TOKEN")),
      "NAO_AUTORIZADO", "Chamada não autorizada.");

    var acao = textoCalendar_(dados.acao).toUpperCase();
    exigirCalendar_(["AGENDAR", "REAGENDAR", "CANCELAR", "ATUALIZAR"].indexOf(acao) >= 0,
      "ACAO_INVALIDA", "Ação não reconhecida.");
    var ids = validarIdentificadoresCalendar_(dados);
    var calendarId = textoCalendar_(props.getProperty("ISABELE_CALENDAR_ID"));
    exigirCalendar_(calendarId !== "", "CALENDARIO_NAO_CONFIGURADO",
      "Calendário de destino não configurado.");
    var calendar = CalendarApp.getCalendarById(calendarId);
    exigirCalendar_(Boolean(calendar), "CALENDARIO_INDISPONIVEL",
      "Calendário de atendimentos indisponível ou sem permissão.");

    lock = LockService.getScriptLock();
    obtido = lock.tryLock(4000);
    exigirCalendar_(obtido, "CALENDARIO_OCUPADO",
      "Calendário ocupado: operação pode ser retomada pela API.");

    var assinatura = assinaturaCalendar_(dados, acao, ids.id);
    var resultado;
    if (acao === "AGENDAR") resultado = agendarCalendar_(calendar, props, dados, ids, assinatura);
    else if (acao === "REAGENDAR") resultado = reagendarCalendar_(calendar, props, dados, ids, assinatura);
    else if (acao === "CANCELAR") resultado = cancelarCalendar_(calendar, props, dados, ids, assinatura);
    else resultado = atualizarCalendar_(calendar, props, dados, ids, assinatura);

    console.log("Calendar unificado: acao=" + acao + "; resultado=" + resultado.status);
    return respostaCalendarUnificado_(resultado);
  } catch (erro) {
    // Evitar nomes, tokens, IDs completos e payloads nos logs de produção.
    var codigo = (erro && erro.codigo) || "ERRO_CALENDAR";
    console.error("Calendar unificado: " + codigo);
    return respostaCalendarUnificado_({
      ok: false, status: "FALHA", errorCode: codigo,
      error: (erro && erro.codigo) ? String(erro.message) : "Falha na integração do calendário.",
      eventId: dados ? textoCalendar_(dados.eventId) : "",
      operationId: dados ? textoCalendar_(dados.operationId) : ""
    });
  } finally {
    if (lock && obtido) lock.releaseLock();
  }
}
