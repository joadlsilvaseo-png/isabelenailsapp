import { validarDataGerenciavel, listarSlotsGerenciaveis } from "./agendamentoRegras.mjs";
import { verificarUsuario } from "./pushSubscriptions.js";

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CORPO = 32768;
const MAX_DATAS_LOTE = 93;
const MAX_INTERVALOS_LOTE = 2400;

export class ErroCalendario extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sobrepoe(inicioA, fimA, inicioB, fimB) {
  return inicioA < fimB && fimA > inicioB;
}

export async function possuiBloqueio(conexao, data, inicio, fim) {
  const resultado = await conexao.query(`
    SELECT 1 FROM public.agenda_bloqueios
    WHERE data_servico = $1
      AND int4range(inicio_minuto, fim_minuto, '[)')
          && int4range($2::integer, $3::integer, '[)')
    LIMIT 1
  `, [data, inicio, fim]);
  return (resultado.rowCount ?? resultado.rows.length) > 0;
}

function resposta(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

async function lerCorpo(req) {
  const partes = [];
  let tamanho = 0;
  for await (const bloco of req) {
    tamanho += bloco.length;
    if (tamanho > MAX_CORPO) throw new ErroCalendario(413, "Seleção muito grande");
    partes.push(bloco);
  }
  let corpo;
  try { corpo = JSON.parse(Buffer.concat(partes).toString("utf8")); }
  catch { throw new ErroCalendario(400, "JSON inválido"); }
  if (!corpo || Array.isArray(corpo) || typeof corpo !== "object") {
    throw new ErroCalendario(400, "Dados inválidos");
  }
  return corpo;
}

async function obterFirestore() {
  const { initializeApp, getApps, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({
    credential: applicationDefault(),
    projectId: "isabele-nails-app",
  });
  return getFirestore();
}

async function conferirAdmin(db, uid) {
  const snapshot = await db.collection("usuarios").doc(uid).get();
  return snapshot.exists && snapshot.data()?.role === "admin" && snapshot.data()?.ativo === true;
}

async function consultarOcupadosFirestore(db, data) {
  const snapshots = await db.collection("agendamentos").where("data", "==", data).get();
  return snapshots.docs.filter((documento) =>
    ["agendado", "reagendado", "confirmado"].includes(documento.data()?.status)
  ).map((documento) => {
    const dados = documento.data();
    const horario = String(dados.horario || "");
    const duracao = Number(dados.duracao ?? 90);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)
      || !Number.isInteger(duracao) || duracao <= 0 || duracao > 1440) {
      throw new Error("Agendamento ativo com período inválido");
    }
    const [h, m] = horario.split(":").map(Number);
    return { inicioMinuto: h * 60 + m, fimMinuto: h * 60 + m + duracao };
  });
}

function validarData(data, agora) {
  if (typeof data !== "string" || !DATA_ISO.test(data)) {
    throw new ErroCalendario(400, "Data inválida");
  }
  const validacao = validarDataGerenciavel(data, agora);
  if (!validacao.valido) throw new ErroCalendario(400, validacao.motivo);
  if (![2, 3, 4, 5, 6].includes(validacao.diaSemana)) {
    throw new ErroCalendario(400, "Dia sem atendimento");
  }
}

function validarSelecao(data, horas, agora) {
  validarData(data, agora);
  const permitidos = new Set(listarSlotsGerenciaveis(data, agora));
  if (!Array.isArray(horas) || horas.length === 0 || horas.length > 48
    || horas.some((m) => !Number.isInteger(m) || !permitidos.has(m))
    || new Set(horas).size !== horas.length) {
    throw new ErroCalendario(400, "Seleção de horários inválida");
  }
}

async function consultarDia(pool, db, data) {
  const [bloqueados, reservas, firestore] = await Promise.all([
    pool.query(`
      SELECT inicio_minuto, fim_minuto FROM public.agenda_bloqueios
      WHERE data_servico = $1 ORDER BY inicio_minuto
    `, [data]),
    pool.query(`
      SELECT inicio_minuto, fim_minuto FROM public.pix_reservas
      WHERE data_servico = $1 AND estado IN ('reservada', 'confirmada')
    `, [data]),
    consultarOcupadosFirestore(db, data),
  ]);
  return {
    bloqueados: bloqueados.rows.map(({ inicio_minuto, fim_minuto }) =>
      ({ inicioMinuto: Number(inicio_minuto), fimMinuto: Number(fim_minuto) })),
    ocupados: [...reservas.rows.map(({ inicio_minuto, fim_minuto }) =>
      ({ inicioMinuto: Number(inicio_minuto), fimMinuto: Number(fim_minuto) })), ...firestore],
  };
}

export async function alterarHorarios({ pool, db, uid, data, horas, acao, agora = new Date() }) {
  if (!["fechar", "reabrir"].includes(acao)) throw new ErroCalendario(400, "Operação inválida");
  validarSelecao(data, horas, agora);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
      [data],
    );
    // Revalidação obrigatória após adquirir o mesmo lock usado pela reserva PIX.
    if (acao === "fechar") {
      const [reservas, doDia] = await Promise.all([
        client.query(`
          SELECT inicio_minuto, fim_minuto FROM public.pix_reservas
          WHERE data_servico = $1 AND estado IN ('reservada', 'confirmada')
        `, [data]),
        consultarOcupadosFirestore(db, data),
      ]);
      const ocupados = [...reservas.rows.map(({ inicio_minuto, fim_minuto }) =>
        ({ inicioMinuto: Number(inicio_minuto), fimMinuto: Number(fim_minuto) })), ...doDia];
      if (horas.some((inicio) =>
        ocupados.some(({ inicioMinuto, fimMinuto }) =>
          sobrepoe(inicio, inicio + 30, inicioMinuto, fimMinuto)))) {
        throw new ErroCalendario(409, "Existem reservas nesses horários. Nenhum horário foi fechado.");
      }
      for (const inicio of horas) {
        await client.query(`
          INSERT INTO public.agenda_bloqueios
            (data_servico, inicio_minuto, fim_minuto, alterado_por_uid)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (data_servico, inicio_minuto) DO NOTHING
        `, [data, inicio, inicio + 30, uid]);
      }
    } else {
      await client.query(`
        DELETE FROM public.agenda_bloqueios
        WHERE data_servico = $1 AND inicio_minuto = ANY($2::integer[])
      `, [data, horas]);
    }
    await client.query("COMMIT");
    return { data, acao, quantidade: horas.length };
  } catch (erro) {
    await client.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally { client.release(); }
}

function formatarMinuto(minuto) {
  return `${String(Math.floor(minuto / 60)).padStart(2, "0")}:${String(minuto % 60).padStart(2, "0")}`;
}

function formatarData(data) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${data}T12:00:00Z`));
}

function validarDatasLote(datas, acao, agora) {
  if (!["fechar", "reabrir"].includes(acao)) throw new ErroCalendario(400, "Operação inválida");
  if (!Array.isArray(datas) || datas.length === 0 || datas.length > MAX_DATAS_LOTE) {
    throw new ErroCalendario(400, "Selecione entre 1 e 93 datas");
  }

  const vistas = new Set();
  let totalIntervalos = 0;
  const normalizadas = datas.map((item) => {
    const data = item?.data;
    const horas = item?.horas;
    if (vistas.has(data)) throw new ErroCalendario(400, "A data foi repetida no lote");
    vistas.add(data);
    validarSelecao(data, horas, agora);
    totalIntervalos += horas.length;
    return { data, horas: [...horas].sort((a, b) => a - b) };
  });
  if (totalIntervalos > MAX_INTERVALOS_LOTE) {
    throw new ErroCalendario(413, "O lote contém intervalos demais");
  }
  return normalizadas.sort((a, b) => a.data.localeCompare(b.data));
}

/** Fecha/reabre várias datas numa transação, com locks adquiridos em ordem determinística. */
export async function alterarHorariosLote({
  pool, db, uid, datas, acao, agora = new Date(),
}) {
  const lote = validarDatasLote(datas, acao, agora);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { data } of lote) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('isabele_pix_agenda'), hashtext($1::text))",
        [data],
      );
    }

    if (acao === "fechar") {
      for (const { data, horas } of lote) {
        const [reservas, firestore] = await Promise.all([
          client.query(`
            SELECT inicio_minuto, fim_minuto FROM public.pix_reservas
            WHERE data_servico = $1 AND estado IN ('reservada', 'confirmada')
          `, [data]),
          consultarOcupadosFirestore(db, data),
        ]);
        const ocupados = [
          ...reservas.rows.map(({ inicio_minuto, fim_minuto }) => ({
            inicioMinuto: Number(inicio_minuto), fimMinuto: Number(fim_minuto),
          })),
          ...firestore,
        ];
        const conflito = horas.find((inicio) =>
          ocupados.some(({ inicioMinuto, fimMinuto }) =>
            sobrepoe(inicio, inicio + 30, inicioMinuto, fimMinuto)));
        if (conflito !== undefined) {
          throw new ErroCalendario(
            409,
            `Conflito em ${formatarData(data)}, ${formatarMinuto(conflito)}–${formatarMinuto(conflito + 30)}. Nenhum horário do lote foi alterado.`,
          );
        }
      }

      // Só grava depois que todas as datas passaram pela revalidação.
      for (const { data, horas } of lote) {
        for (const inicio of horas) {
          await client.query(`
            INSERT INTO public.agenda_bloqueios
              (data_servico, inicio_minuto, fim_minuto, alterado_por_uid)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (data_servico, inicio_minuto) DO NOTHING
          `, [data, inicio, inicio + 30, uid]);
        }
      }
    } else {
      for (const { data, horas } of lote) {
        await client.query(`
          DELETE FROM public.agenda_bloqueios
          WHERE data_servico = $1 AND inicio_minuto = ANY($2::integer[])
        `, [data, horas]);
      }
    }

    await client.query("COMMIT");
    return {
      acao,
      quantidadeDatas: lote.length,
      quantidadeIntervalos: lote.reduce((total, item) => total + item.horas.length, 0),
      datas: lote.map(({ data }) => data),
    };
  } catch (erro) {
    await client.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    client.release();
  }
}

export async function atenderGerenciarCalendario(req, res, pool, dependencies = {}) {
  const url = new URL(req.url, "http://localhost");
  const rotaLote = url.pathname === "/admin/calendario/lote";
  const rotaIndividual = url.pathname === "/admin/calendario";
  if ((!rotaLote && !rotaIndividual) ||
      (rotaLote && req.method !== "POST") ||
      (rotaIndividual && !["GET", "POST"].includes(req.method))) {
    resposta(res, 405, { erro: "Método não permitido" });
    return;
  }
  let uid;
  try { uid = await (dependencies.verificarUsuario || verificarUsuario)(req); }
  catch { resposta(res, 401, { erro: "Não autenticado" }); return; }
  try {
    const db = dependencies.firestore || await obterFirestore();
    if (!(await conferirAdmin(db, uid))) {
      resposta(res, 403, { erro: "Acesso administrativo negado" });
      return;
    }
    const agora = dependencies.now || new Date();
    if (req.method === "GET") {
      const data = url.searchParams.get("data");
      validarData(data, agora);
      const dia = await consultarDia(pool, db, data);
      resposta(res, 200, dia);
    } else {
      const corpo = await lerCorpo(req);
      const resultado = rotaLote
        ? await alterarHorariosLote({
            pool, db, uid, datas: corpo.datas, acao: corpo.acao, agora,
          })
        : await alterarHorarios({
            pool, db, uid, data: corpo.data, horas: corpo.horas,
            acao: corpo.acao, agora,
          });
      resposta(res, 200, resultado);
    }
  } catch (erro) {
    if (erro instanceof ErroCalendario) {
      resposta(res, erro.status, { erro: erro.message }); return;
    }
    console.error("[Gerenciar Calendário] Falha:", erro.message);
    resposta(res, 503, { erro: "Não foi possível consultar ou atualizar o calendário" });
  }
}
