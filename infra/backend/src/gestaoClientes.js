const UID = /^[A-Za-z0-9_-]{1,128}$/;
const LIMITE_PADRAO = 20;
const LIMITE_MAXIMO = 50;
const LOTE_BUSCA = 100;
const LIMITE_VARREDURA = 500;
const CANCELADOS = new Set(["cancelado", "cancelada", "cancelado_cliente", "cancelado_profissional", "cancelled", "canceled"]);
const CONCLUIDOS = new Set(["concluido", "concluida", "realizado", "realizada", "finalizado", "finalizada", "completed"]);

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(dados));
}

function normalizar(valor) {
  return String(valor ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function texto(valor, max = 180) {
  return String(valor ?? "").trim().slice(0, max);
}

function dataValor(valor) {
  if (valor?.toDate) return valor.toDate().toISOString();
  if (valor instanceof Date) return valor.toISOString();
  return texto(valor, 40);
}

function perfil(uid, dados = {}) {
  return {
    id: uid,
    name: texto(dados.nome || dados.nomeCliente || dados.name || "Cliente", 120),
    phone: texto(dados.telefone || dados.celular || dados.whatsapp || dados.phone, 50),
    email: texto(dados.email || dados.emailCliente, 180),
    createdAt: dataValor(dados.dataCadastro || dados.criadoEm || dados.createdAt),
  };
}

function projecaoAgendamento(snapshot) {
  const dados = snapshot.data() || {};
  return {
    id: snapshot.id,
    date: dataValor(dados.data || dados.dataAgendamento || dados.date),
    time: texto(dados.horario || dados.hora || dados.time, 20),
    service: texto(dados.servico || dados.nomeServico || dados.servicoNome, 120),
    status: texto(dados.status || "agendado", 50),
  };
}

function agoraSaoPaulo() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${valores.year}-${valores.month}-${valores.day}T${valores.hour}:${valores.minute}`;
}

function dataHora(item) {
  return `${String(item.date || "").slice(0, 10)}T${item.time || "00:00"}`;
}

function nomeServico(dados = {}) {
  return texto(dados.nome || dados.nomeServico || dados.servico || dados.name || "Serviço não informado", 120);
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;
  for await (const parte of req) {
    tamanho += parte.length;
    if (tamanho > 4096) throw Object.assign(new Error("Requisição muito grande"), { status: 413 });
    partes.push(parte);
  }
  try {
    const dados = JSON.parse(Buffer.concat(partes).toString("utf8"));
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) throw new Error("JSON inválido");
    return dados;
  } catch {
    throw Object.assign(new Error("JSON inválido"), { status: 400 });
  }
}

async function bancoPadrao() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  return getFirestore();
}

async function adminAtivo(db, uid) {
  const snapshot = await db.collection("usuarios").doc(uid).get();
  const dados = snapshot.exists ? snapshot.data() : null;
  return dados?.role === "admin" && dados?.ativo === true;
}

async function validarPerfilCliente(db, uid, snapshot) {
  const usuario = await db.collection("usuarios").doc(uid).get();
  if (!snapshot.exists || normalizar(snapshot.data()?.role) === "admin" || normalizar(usuario.data()?.role) === "admin") {
    const erro = new Error("Cadastro de cliente não encontrado.");
    erro.status = 404;
    throw erro;
  }
}

async function buscarPagina({ db, query, cursor, limit }) {
  const clientes = db.collection("clientes");
  const adminsSnapshot = await db.collection("usuarios").where("role", "==", "admin").get();
  const adminUids = new Set(adminsSnapshot.docs.map((doc) => doc.id));
  if (cursor && !UID.test(cursor)) {
    const erro = new Error("Cursor de paginação inválido."); erro.status = 400; throw erro;
  }
  let lastId = cursor || "";
  let scanned = 0;
  const matches = [];
  let exhausted = false;
  let foundExtra = false;
  while (scanned < LIMITE_VARREDURA) {
    let request = clientes.orderBy("__name__").limit(LOTE_BUSCA);
    if (lastId) request = request.startAfter(clientes.doc(lastId));
    const snapshot = await request.get();
    if (snapshot.empty) { exhausted = true; break; }
    for (const doc of snapshot.docs) {
      lastId = doc.id;
      scanned += 1;
      const dados = doc.data() || {};
      const corresponde = normalizar(dados.role) !== "admin" && !adminUids.has(doc.id) && (!query || normalizar([
        dados.nome, dados.nomeCliente, dados.name, dados.telefone, dados.celular,
        dados.whatsapp, dados.phone, dados.email, dados.emailCliente,
      ].join(" ")).includes(query));
      if (corresponde) {
        if (matches.length === limit) { foundExtra = true; break; }
        matches.push(perfil(doc.id, dados));
      }
      if (scanned >= LIMITE_VARREDURA) break;
    }
    if (foundExtra || scanned >= LIMITE_VARREDURA) break;
    if (snapshot.docs.length < LOTE_BUSCA) { exhausted = true; break; }
  }
  const hasMore = foundExtra || !exhausted;
  const items = matches.slice(0, limit);
  return {
    items,
    nextCursor: hasMore ? (foundExtra ? items.at(-1)?.id : lastId) : null,
    hasMore,
    scanLimitReached: !exhausted && !foundExtra && scanned >= LIMITE_VARREDURA,
  };
}

async function obterPerfil({ db, pool, uid }) {
  const cliente = await db.collection("clientes").doc(uid).get();
  await validarPerfilCliente(db, uid, cliente);
  const agendamentos = db.collection("agendamentos");
  const camposCliente = ["clienteId", "idCliente", "usuarioId", "uidCliente", "userId"];
  const snapshots = await Promise.all(camposCliente.map((campo) =>
    agendamentos.where(campo, "==", uid).limit(200).get(),
  ));
  const registros = new Map();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) registros.set(doc.id, projecaoAgendamento(doc));
  }
  const todos = [...registros.values()].sort((a, b) => dataHora(b).localeCompare(dataHora(a)));

  const reservasResult = await pool.query(`
    SELECT agendamento_id, servico_id, data_servico::text AS data_servico,
           inicio_minuto, estado
    FROM public.pix_reservas
    WHERE cliente_uid = $1
    ORDER BY data_servico DESC, inicio_minuto DESC
    LIMIT 200
  `, [uid]);
  const idsFirestore = new Set(todos.map((item) => item.id));
  const reservasSemAgendamento = reservasResult.rows.filter((row) => !row.agendamento_id || !idsFirestore.has(row.agendamento_id));
  const servicoIds = [...new Set(reservasSemAgendamento.map((row) => row.servico_id).filter((id) => typeof id === "string" && UID.test(id)))];
  const servicos = await Promise.all(servicoIds.map((id) => db.collection("servicos").doc(id).get()));
  const nomesServicos = new Map(servicos.filter((doc) => doc.exists).map((doc) => [doc.id, nomeServico(doc.data())]));
  const reservas = reservasSemAgendamento.map((row) => {
    const inicio = Number(row.inicio_minuto);
    const time = Number.isInteger(inicio) && inicio >= 0 && inicio < 1440
      ? `${String(Math.floor(inicio / 60)).padStart(2, "0")}:${String(inicio % 60).padStart(2, "0")}` : "Horário não informado";
    const status = row.estado === "reservada" ? "Aguardando pagamento PIX" :
      row.estado === "confirmada" ? "Reserva PIX confirmada" :
        row.estado === "expirada" ? "Reserva PIX expirada" : "Reserva PIX cancelada";
    return {
      id: `pix-${row.agendamento_id || `${row.data_servico}-${inicio}`}`,
      date: row.data_servico,
      time,
      service: nomesServicos.get(row.servico_id) || "Serviço não informado",
      status,
    };
  });
  const combinados = [...todos, ...reservas].sort((a, b) => dataHora(b).localeCompare(dataHora(a)));
  const agora = agoraSaoPaulo();
  const upcoming = combinados.filter((item) =>
    !CANCELADOS.has(normalizar(item.status)) && !CONCLUIDOS.has(normalizar(item.status)) && dataHora(item) >= agora,
  ).sort((a, b) => dataHora(a).localeCompare(dataHora(b)));
  const upcomingIds = new Set(upcoming.map((item) => item.id));
  const history = combinados.filter((item) => !upcomingIds.has(item.id));
  const completed = todos.filter((item) => CONCLUIDOS.has(normalizar(item.status)));
  const note = await pool.query(
    "SELECT nota, updated_at FROM public.cliente_observacoes_admin WHERE cliente_uid = $1",
    [uid],
  );
  return {
    client: perfil(uid, cliente.data()),
    completedCount: completed.length,
    historyComplete: snapshots.every((snapshot) => snapshot.docs.length < 200) && reservasResult.rows.length < 200,
    lastVisit: completed[0]?.date || null,
    upcoming,
    history,
    internalNote: note.rows[0]?.nota || "",
  };
}

async function salvarObservacao({ db, pool, uid, adminUid, note }) {
  const cliente = await db.collection("clientes").doc(uid).get();
  await validarPerfilCliente(db, uid, cliente);
  if (typeof note !== "string" || note.length > 3000) {
    const erro = new Error("A observação deve conter até 3.000 caracteres."); erro.status = 400; throw erro;
  }
  const salvo = await pool.query(`
    INSERT INTO public.cliente_observacoes_admin (cliente_uid, nota, updated_by_uid, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (cliente_uid) DO UPDATE SET
      nota = EXCLUDED.nota, updated_by_uid = EXCLUDED.updated_by_uid, updated_at = NOW()
    RETURNING nota, updated_at
  `, [uid, note.trim(), adminUid]);
  return salvo.rows[0];
}

export async function atenderGestaoClientes(req, res, pool, dependencies = {}) {
  let adminUid;
  try {
    const verificar = dependencies.verificarUsuario || (await import("./pushSubscriptions.js")).verificarUsuario;
    adminUid = await verificar(req);
  } catch {
    responder(res, 401, { erro: "Não autenticado." });
    return;
  }
  try {
    const db = dependencies.firestore || await bancoPadrao();
    if (!(await adminAtivo(db, adminUid))) {
      responder(res, 403, { erro: "Acesso administrativo negado." });
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const caminho = url.pathname;
    if (req.method === "GET" && caminho === "/admin/clientes") {
      const rawLimit = Number.parseInt(url.searchParams.get("limit") || String(LIMITE_PADRAO), 10);
      const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(LIMITE_MAXIMO, rawLimit)) : LIMITE_PADRAO;
      const query = normalizar(url.searchParams.get("q")).slice(0, 100);
      const resultado = await buscarPagina({ db, query, cursor: url.searchParams.get("cursor") || "", limit });
      responder(res, 200, resultado);
      return;
    }
    const match = /^\/admin\/clientes\/([^/]+)(?:\/(observacoes))?$/.exec(caminho);
    if (match) {
      const uid = decodeURIComponent(match[1]);
      if (!UID.test(uid)) { responder(res, 400, { erro: "Identificador da cliente inválido." }); return; }
      if (!match[2] && req.method === "GET") {
        responder(res, 200, await obterPerfil({ db, pool, uid }));
        return;
      }
      if (match[2] && req.method === "PUT") {
        const body = await lerJson(req);
        const salvo = await salvarObservacao({ db, pool, uid, adminUid, note: body.note });
        responder(res, 200, { ok: true, ...salvo });
        return;
      }
    }
    responder(res, 404, { erro: "Rota não encontrada." });
  } catch (erro) {
    if (erro.status) { responder(res, erro.status, { erro: erro.message }); return; }
    console.error("[Gestão de clientes] Falha na operação:", erro.message);
    responder(res, 500, { erro: "Falha ao processar a gestão de clientes." });
  }
}
