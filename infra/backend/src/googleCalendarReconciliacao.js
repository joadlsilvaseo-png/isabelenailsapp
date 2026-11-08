/**
 * Fase 2.4-2.5 — conciliador estritamente read-only, sem efeitos colaterais.
 * Confronta IDs documentados com events.id e iCalUID; NUNCA infere
 * vinculacao por nome de cliente, titulo ou coincidencia de horario.
 * Nenhum candidato e convertido automaticamente em vinculo confirmado.
 */
const ID_AGENDAMENTO = /^[a-zA-Z0-9_-]{1,128}$/;
const ID_GOOGLE = /^[a-v0-9]{5,1024}$/;

function erro(codigo) {
  return Object.assign(new Error("Inventario Calendar inconsistente: " + codigo), { codigo });
}
function validarArray(lista, nome, limite) {
  if (!Array.isArray(lista) || lista.length > limite) throw erro("LIMITE_" + nome);
}
function validarAgendamento(id) {
  if (typeof id !== "string" || !ID_AGENDAMENTO.test(id)) throw erro("ID_AGENDAMENTO_INVALIDO");
  return id;
}
function validarEvento(id) {
  if (typeof id !== "string" || !ID_GOOGLE.test(id)) throw erro("ID_EVENTO_INVALIDO");
  return id;
}
const codigoResumo = (itens) => Object.fromEntries(
  [...new Set(itens.map(x => x.situacao))].sort().map(s => [s, itens.filter(x => x.situacao === s).length]),
);

/**
 * @returns relatorio SEM nomes, titulos, telefones ou horarios.
 * Vinculos existentes ja confirmados nao sao reescritos.
 */
export function conciliarEventosGoogle({ agendamentos = [], outbox = [], eventos = [], vinculos = [] } = {}) {
  validarArray(agendamentos, "AGENDAMENTOS", 4000);
  validarArray(outbox, "OUTBOX", 4000);
  validarArray(eventos, "GOOGLE", 1500);
  validarArray(vinculos, "VINCULOS", 4000);

  const todos = new Map();
  function reservar(id) {
    const chave = validarAgendamento(id);
    if (!todos.has(chave)) todos.set(chave, { id: chave, refs: new Set(), fontes: new Map() });
    return todos.get(chave);
  }
  function referencia(ag, valor, fonte) {
    if (valor === null || valor === undefined || valor === "") return;
    if (typeof valor !== "string" || valor.length > 1024) throw erro("REFERENCIA_INVALIDA");
    // Legacy event_id pode ser iCalUID, com @; nunca converter em events.id.
    ag.refs.add(valor);
    if (!ag.fontes.has(valor)) ag.fontes.set(valor, new Set());
    ag.fontes.get(valor).add(fonte);
  }
  for (const item of agendamentos) {
    const ag = reservar(item?.id);
    referencia(ag, item.calendarEventId, "firestore");
  }
  for (const item of outbox) {
    const ag = reservar(item?.agendamento_id);
    referencia(ag, item.event_id, "pix_outbox");
  }

  const porId = new Map(), porIcal = new Map();
  for (const ev of eventos) {
    const id = validarEvento(ev?.id);
    if (porId.has(id)) throw erro("GOOGLE_ID_REPETIDO");
    porId.set(id, ev);
    if (typeof ev.iCalUID === "string" && ev.iCalUID.length <= 1024) {
      if (!porIcal.has(ev.iCalUID)) porIcal.set(ev.iCalUID, new Set());
      porIcal.get(ev.iCalUID).add(id);
    }
    const propriedade = ev.extendedProperties?.private;
    if (propriedade?.isabeleOrigem === "isabele-vps" &&
        propriedade?.isabeleAgendamentoId) {
      const ag = reservar(propriedade.isabeleAgendamentoId);
      referencia(ag, id, "marcador_vps");
    }
  }

  const vinculoPorAg = new Map();
  const vinculadosPorEvento = new Map();
  for (const v of vinculos) {
    const agId = validarAgendamento(v?.agendamento_id);
    const id = validarEvento(v?.google_event_id);
    if (vinculoPorAg.has(agId)) throw erro("VINCULO_DUPLICADO_AGENDAMENTO");
    if (vinculadosPorEvento.has(id) && vinculadosPorEvento.get(id) !== agId) {
      throw erro("VINCULO_DUPLICADO_EVENTO");
    }
    if (!["vps", "legado_validado"].includes(v.origem)) throw erro("VINCULO_ORIGEM_INVALIDA");
    vinculoPorAg.set(agId, v);
    vinculadosPorEvento.set(id, agId);
    reservar(agId);
  }

  const registros = [];
  const reivindicacoes = new Map();
  for (const ag of [...todos.values()].sort((a,b)=>a.id.localeCompare(b.id))) {
    const lista = new Map();
    function incluir(id, motivo) {
      const e = porId.get(id);
      if (!e || e.status === "cancelled") return;
      if (!lista.has(id)) lista.set(id, new Set());
      lista.get(id).add(motivo);
    }
    for (const ref of ag.refs) {
      if (porId.has(ref)) incluir(ref, ag.fontes.get(ref)?.has("marcador_vps") ? "marcador_vps" : "id_exato");
      for (const id of porIcal.get(ref) || []) incluir(id, "icaluid_exato");
    }
    const anterior = vinculoPorAg.get(ag.id);
    if (anterior) incluir(anterior.google_event_id, "vinculo_existente");
    const ids = [...lista.keys()].sort();
    let situacao;
    if (anterior && !porId.has(anterior.google_event_id)) {
      situacao = "vinculo_ausente";
    } else if (anterior && ids.length === 1 &&
               ids[0] === anterior.google_event_id) {
      situacao = "vinculo_confirmado";
    } else if (anterior && (ids.length !== 1 || ids[0] !== anterior.google_event_id)) {
      situacao = "conflito_vinculo";
    } else if (ids.length === 0) {
      situacao = "sem_correspondencia";
    } else if (ids.length > 1) {
      situacao = "ambiguo";
    } else if (lista.get(ids[0]).has("marcador_vps")) {
      situacao = "candidato_marcador_vps";
    } else {
      situacao = "candidato_legado";
    }

    // Um evento identificado por duas reservas nao pode ser validado por
    // nenhuma delas: marcar ambos como conflito antes de qualquer acao.
    for (const id of ids) {
      if (!reivindicacoes.has(id)) reivindicacoes.set(id, new Set());
      reivindicacoes.get(id).add(ag.id);
    }
    registros.push({
      agendamentoId: ag.id, situacao,
      candidatos: ids.map(id => ({
        googleEventId: id,
        evidencias: [...lista.get(id)].sort(),
      })),
    });
  }
  for (const registro of registros) {
    if (registro.candidatos.some(c => reivindicacoes.get(c.googleEventId).size > 1)) {
      registro.situacao = "conflito_multiplos_agendamentos";
    }
    if (registro.candidatos.some(c => {
      const p = porId.get(c.googleEventId)?.extendedProperties?.private;
      return p?.isabeleOrigem === "isabele-vps" &&
        p?.isabeleAgendamentoId && p.isabeleAgendamentoId !== registro.agendamentoId;
    })) registro.situacao = "conflito_marcador";
    // Ocorrencias recorrentes merecem revisao, mesmo com ID valido.
    if (registro.situacao.startsWith("candidato_") && registro.candidatos.some(
      c => Boolean(porId.get(c.googleEventId)?.recurringEventId),
    )) registro.situacao = "revisao_recorrencia";
  }

  const eventosSemReferencia = [...porId.keys()].filter(id => !reivindicacoes.has(id));
  return {
    somenteLeitura: true, gerouVinculos: false,
    resumo: { agendamentos: registros.length, eventosGoogle: porId.size,
      eventosSemReferencia: eventosSemReferencia.length,
      situacoes: codigoResumo(registros) },
    registros,
  };
}
