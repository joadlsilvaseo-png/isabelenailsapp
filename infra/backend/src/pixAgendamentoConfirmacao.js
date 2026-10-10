function responder(res, status, dados) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(dados));
}

async function firestoreAdmin() {
  const { initializeApp, applicationDefault, getApps } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: "isabele-nails-app" });
  return getFirestore();
}

export async function atenderConfirmacaoAgendamentoPix(req, res, pool, dependencias = {}) {
  let uid;
  try {
    uid = await (dependencias.verificarUsuario || (await import("./pushSubscriptions.js")).verificarUsuario)(req);
  } catch {
    responder(res, 401, { erro: "Nao autenticado" });
    return;
  }
  try {
    const partes = [];
    let tamanho = 0;
    for await (const parte of req) {
      tamanho += parte.length;
      if (tamanho > 2048) { responder(res, 413, { erro: "Requisicao muito grande" }); return; }
      partes.push(parte);
    }
    let dados;
    try { dados = JSON.parse(Buffer.concat(partes).toString("utf8")); }
    catch { responder(res, 400, { erro: "JSON invalido" }); return; }
    const reservaId = dados?.reservaId;
    if (typeof reservaId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reservaId)) {
      responder(res, 400, { erro: "Reserva invalida" }); return;
    }
    const consulta = await pool.query(`SELECT c.estado AS estado_cobranca,
        c.agendamento_id, c.valor_total_centavos, c.valor_sinal_centavos,
        c.valor_restante_centavos, r.estado AS estado_reserva
      FROM public.pix_reservas r JOIN public.pix_cobrancas c ON c.id = r.cobranca_id
      WHERE r.id = $1 AND r.cliente_uid = $2 AND c.cliente_uid = $2`, [reservaId, uid]);
    const registro = consulta.rows[0];
    if (!registro) { responder(res, 404, { erro: "Reserva nao encontrada" }); return; }
    if (!["paga", "estornada"].includes(registro.estado_cobranca) || !registro.agendamento_id || registro.estado_reserva !== "confirmada") {
      responder(res, 202, { agendamentoConfirmado: false, situacao: registro.estado_cobranca }); return;
    }
    const banco = dependencias.firestore || await firestoreAdmin();
    const documento = await banco.collection("agendamentos").doc(registro.agendamento_id).get();
    if (!documento.exists) { responder(res, 202, { agendamentoConfirmado: false, situacao: "sincronizacao_pendente" }); return; }
    const atendimento = documento.data();
    if (atendimento.clienteId !== uid || atendimento.status !== "confirmado") {
      responder(res, 202, { agendamentoConfirmado: false, situacao: "confirmacao_pendente" }); return;
    }
    responder(res, 200, {
      agendamentoConfirmado: true,
      situacao: "agendamento_confirmado",
      cliente: atendimento.nomeCliente || "Cliente",
      servico: atendimento.servico || "Atendimento",
      data: atendimento.data,
      horario: atendimento.horario,
      valorTotalCentavos: Number(registro.valor_total_centavos),
      sinalPagoCentavos: Number(registro.valor_sinal_centavos),
      valorRestanteCentavos: Number(registro.valor_restante_centavos),
      statusFinanceiro: atendimento.pixStatusFinanceiro || "pago"
    });
  } catch (erro) {
    console.error("[PIX Confirmacao] Falha ao consultar estado:", erro.message);
    responder(res, 503, { erro: "Nao foi possivel consultar o agendamento" });
  }
}
