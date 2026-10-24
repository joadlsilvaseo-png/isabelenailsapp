const FUSO_AGENDAMENTOS = "America/Sao_Paulo";
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;
const formatadorFuso = new Intl.DateTimeFormat("en-US", {
  timeZone: FUSO_AGENDAMENTOS,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const STATUS_ATIVOS = new Set(["agendado", "confirmado", "reagendado"]);

function texto(valor) {
  return String(valor ?? "").trim();
}

function normalizarHorario(valor) {
  const horario = texto(valor).slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(horario) ? horario : "";
}

export function extrairAgendamento(dados, id = "") {
  return {
    id: texto(id || dados?.id),
    clienteId: texto(
      dados?.clienteId || dados?.idCliente || dados?.usuarioId ||
      dados?.uidCliente || dados?.userId,
    ),
    status: texto(dados?.status || "agendado").toLowerCase(),
    data: texto(dados?.data || dados?.dataAgendamento),
    horario: normalizarHorario(dados?.horario || dados?.hora),
    servico: texto(dados?.servico || dados?.nomeServico || dados?.servicoNome),
    nomeCliente: texto(dados?.nomeCliente),
    origemPagamento: texto(dados?.origemPagamento),
  };
}

export function agendamentoAtivo(agendamento) {
  return STATUS_ATIVOS.has(texto(agendamento?.status).toLowerCase());
}

function obterPartesDataHora(partes) {
  const valores = Object.fromEntries(partes.map(({ type, value }) => [type, Number(value)]));
  return {
    ano: valores.year,
    mes: valores.month,
    dia: valores.day,
    hora: valores.hour,
    minuto: valores.minute,
    segundo: valores.second,
  };
}

/** Converte a data e a hora civil do aplicativo para um instante real em São Paulo. */
export function instanteAgendamentoSaoPaulo(data, horario) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto(data)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(texto(horario))) {
    return null;
  }

  const [ano, mes, dia] = data.split("-").map(Number);
  const [hora, minuto] = horario.split(":").map(Number);
  const baseUtc = Date.UTC(ano, mes - 1, dia, hora, minuto);
  const dataVerificacao = new Date(Date.UTC(ano, mes - 1, dia, 12));

  if (
    dataVerificacao.getUTCFullYear() !== ano ||
    dataVerificacao.getUTCMonth() !== mes - 1 ||
    dataVerificacao.getUTCDate() !== dia
  ) {
    return null;
  }

  let candidato = baseUtc;
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const local = obterPartesDataHora(formatadorFuso.formatToParts(new Date(candidato)));
    const localComoUtc = Date.UTC(
      local.ano, local.mes - 1, local.dia, local.hora, local.minuto, local.segundo,
    );
    const proximo = baseUtc - (localComoUtc - candidato);
    if (proximo === candidato) break;
    candidato = proximo;
  }

  const confirmado = obterPartesDataHora(formatadorFuso.formatToParts(new Date(candidato)));
  if (
    confirmado.ano !== ano || confirmado.mes !== mes || confirmado.dia !== dia ||
    confirmado.hora !== hora || confirmado.minuto !== minuto
  ) {
    return null;
  }

  return new Date(candidato);
}

function formatarData(data) {
  const [ano, mes, dia] = data.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function criarLembretesAgendamento(agendamento, versao, agora = new Date()) {
  if (!agendamentoAtivo(agendamento) || !agendamento?.clienteId || !agendamento?.servico) {
    return [];
  }

  const inicio = instanteAgendamentoSaoPaulo(agendamento.data, agendamento.horario);
  const agoraMs = new Date(agora).getTime();
  if (!inicio || !Number.isFinite(agoraMs) || inicio.getTime() <= agoraMs) return [];

  const detalhes = `Seu atendimento de ${agendamento.servico} está marcado para ${formatarData(agendamento.data)}, às ${agendamento.horario}. Estamos te esperando!`;
  return [
    { tipo: "lembrete_24h", antecedenciaMs: 24 * HORA_MS },
    { tipo: "lembrete_1h", antecedenciaMs: HORA_MS },
  ]
    .map(({ tipo, antecedenciaMs }) => ({
      tipo,
      agendadoPara: new Date(inicio.getTime() - antecedenciaMs),
      inicioAgendamento: inicio,
      chaveEvento: `${agendamento.id}:${versao}:${tipo}:${agendamento.clienteId}`,
      agendamentoId: agendamento.id,
      destinatarioUid: agendamento.clienteId,
      agendamentoVersao: versao,
      titulo: "Lembrete de Agendamento 💅",
      mensagem: detalhes,
      destino: "./meu-perfil.html",
    }))
    .filter((lembrete) => lembrete.agendadoPara.getTime() > agoraMs);
}

/** Persiste lembretes na própria outbox, cancelando versões ainda pendentes. */
export async function sincronizarLembretesAgendamento(conexao, agendamento, versao, agora = new Date()) {
  const ativo = agendamentoAtivo(agendamento) && Boolean(agendamento?.clienteId);
  await conexao.query(
    `
    UPDATE public.push_entregas
    SET estado = 'cancelado', reservado_em = NULL
    WHERE agendamento_id = $1
      AND tipo IN ('lembrete_24h', 'lembrete_1h')
      AND estado IN ('pendente', 'processando')
      AND (
        $2::boolean = FALSE OR
        agendamento_versao IS DISTINCT FROM $3::integer
      )
    `,
    [agendamento.id, ativo, versao],
  );

  if (!ativo) return 0;

  const lembretes = criarLembretesAgendamento(agendamento, versao, agora);
  for (const lembrete of lembretes) {
    await conexao.query(
      `
      INSERT INTO public.push_entregas (
        chave_evento,
        agendamento_id,
        destinatario_uid,
        tipo,
        titulo,
        mensagem,
        destino,
        proxima_tentativa,
        agendado_para,
        agendamento_versao
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)
      ON CONFLICT (chave_evento) DO NOTHING
      `,
      [
        lembrete.chaveEvento,
        lembrete.agendamentoId,
        lembrete.destinatarioUid,
        lembrete.tipo,
        lembrete.titulo,
        lembrete.mensagem,
        lembrete.destino,
        lembrete.agendadoPara,
        lembrete.agendamentoVersao,
      ],
    );
  }
  return lembretes.length;
}
