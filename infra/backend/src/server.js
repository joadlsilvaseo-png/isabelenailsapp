import http from "node:http";
import pg from "pg";
import { registrarInscricaoPush } from "./pushSubscriptions.js";
import { enviarTestePush } from "./pushSender.js";
import { iniciarMonitorAgendamentos } from "./agendaMonitor.js";
import { iniciarWorkerPush } from "./pushWorker.js";
import { atenderCentralNotificacoes } from "./centralNotificacoes.js";
import { atenderAcaoAgendamento } from "./agendamentosAcoes.js";
import { iniciarWorkerAgendamentoCancelamentos } from "./agendamentoCancelamentos.js";
import { criarReservaPix } from "./pixReservas.js";
import { emitirPixDaReserva } from "./pixPedidos.js";
import { consultarStatusPagamentoPix } from "./pixConsultaPagamento.js";
import { atenderWebhookPix } from "./pixWebhook.js";
import { cotarSinalPix } from "./pixCotacao.js";
import { iniciarWorkerPixCalendar } from "./pixCalendarWorker.js";
import { atenderConfirmacaoAgendamentoPix } from "./pixAgendamentoConfirmacao.js";
import { iniciarWorkerPixWebhook } from "./pixWebhookWorker.js";
import { iniciarWorkerPixPolling } from "./pixPollingWorker.js";
import { atenderAgendamentoIsencao } from "./agendamentosIsencaoPix.js";
import { iniciarWorkerReagendamentoPixPago } from "./pixReagendamentoPagoOperacao.js";
import { pixPagoReagendamentoHabilitado } from "./pixReagendamentoPago.js";
import { consultarDisponibilidadePix } from "./pixDisponibilidadeApi.js";
import { atenderGerenciarCalendario } from "./agendaBloqueios.js";
import { atenderGestaoClientes } from "./gestaoClientes.js";
import { atenderFotosPerfil } from "./fotosPerfil.js";
import { atenderAlteracaoServico, iniciarWorkerAlteracaoServico } from "./agendamentoAlteracaoServico.js";
import { atenderAssistenteEncaixes } from "./assistenteEncaixes.js";
import { iniciarMonitorOportunidades } from "./assistenteEncaixesMonitor.js";
import { atenderGoogleCalendarOAuth } from "./googleCalendarOAuth.js";
import { criarPonteCalendarDireto } from "./googleCalendarDirectBridge.js";

const { Pool } = pg;

const pool = new Pool();
// Sem flags de cutover, o roteador nao acessa Google nem cria jobs.
const ponteCalendar = criarPonteCalendarDireto(pool);
const transportePixCalendar = {
  ...(ponteCalendar.habilitado("criar_pix")
    ? { enviarCriacao: (row) => ponteCalendar.criarPix(row) } : {}),
  ...(ponteCalendar.habilitado("cancelar")
    ? { enviarCancelamento: (row) => ponteCalendar.cancelar(row) } : {}),
};
const transporteReagendamentoPix = ponteCalendar.habilitado("reagendar_pago")
  ? { enviarCalendar: (payload) => ponteCalendar.reagendarPago(payload) } : {};
const transporteReagendamentoIsento = ponteCalendar.habilitado("reagendar_isento")
  ? { enviarCalendarSemPix: (payload) => ponteCalendar.reagendarIsento(payload) } : {};
const transporteAlteracaoServico = ponteCalendar.habilitado("alterar_servico")
  ? { enviarCalendar: (row) => ponteCalendar.alterarServico(row) } : {};
const PORT = Number(process.env.PORT || 3001);

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error("Chaves VAPID não configuradas no servidor.");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Integracao OAuth Google Calendar: rotas isoladas e desativadas por padrao.
  // Nenhum endpoint de agendamento ou worker usa este modulo nesta fase.
  if (new URL(req.url, "http://localhost").pathname.startsWith("/oauth/google/")) {
    await atenderGoogleCalendarOAuth(req, res, pool);
    return;
  }

  if (req.method === "GET" && req.url === "/push/public-key") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        publicKey: VAPID_PUBLIC_KEY,
      }),
    );
    return;
  }

  if (req.method === "POST" && req.url === "/push/subscribe") {
    await registrarInscricaoPush(req, res, pool);
    return;
  }

  if (req.method === "POST" && req.url === "/push/test") {
    await enviarTestePush(req, res, pool);
    return;
  }

  // PIX - Cotacao segura do sinal
  if (req.method === "POST" && req.url === "/pix/cotacao") {
    await cotarSinalPix(req, res, pool);
    return;
  }

  // Central de notificações
  if (
    new URL(req.url, "http://localhost").pathname.startsWith("/notificacoes")
  ) {
    await atenderCentralNotificacoes(req, res, pool);
    return;
  }

  // Acoes protegidas de agendamentos
  if (req.method === "POST" && req.url === "/agendamentos/acao") {
    await atenderAcaoAgendamento(req, res, pool);
    return;
  }

  if (new URL(req.url, "http://localhost").pathname === "/admin/agendamentos/servico") {
    await atenderAlteracaoServico(req, res, pool, transporteAlteracaoServico);
    return;
  }

  if (
    [
      "/agendamentos/isencao",
      "/agendamentos/sem-pix",
      "/agendamentos/reagendar",
      "/agendamentos/reagendar/config",
      "/admin/isencoes-sinal-pix",
      "/admin/clientes/isencao-sinal-pix",
    ].includes(new URL(req.url, "http://localhost").pathname)
  ) {
    await atenderAgendamentoIsencao(req, res, pool, transporteReagendamentoIsento);
    return;
  }

  if (
    /^\/admin\/clientes(?:\/[^/]+(?:\/observacoes)?)?$/.test(
      new URL(req.url, "http://localhost").pathname,
    )
  ) {
    await atenderGestaoClientes(req, res, pool);
    return;
  }

  // Fotos de perfil — administradora e clientes
  const caminhoFoto = new URL(req.url, "http://localhost").pathname;

  if (
    caminhoFoto === "/perfil/foto" ||
    /^\/admin\/clientes\/[^/]+\/foto$/.test(caminhoFoto)
  ) {
    await atenderFotosPerfil(req, res, pool);
    return;
  }

  // Bloqueios operacionais: exclusivamente administração, sem Google Agenda.
  if (/^\/admin\/calendario(?:\/lote)?$/.test(new URL(req.url, "http://localhost").pathname)) {
    await atenderGerenciarCalendario(req, res, pool);
    return;
  }

  // Assistente consultivo de encaixes — acesso administrativo, somente leitura.
  if (new URL(req.url, "http://localhost").pathname === "/admin/assistente/encaixes") {
    await atenderAssistenteEncaixes(req, res, pool);
    return;
  }

  // PIX - Reserva temporaria autenticada
  if (req.method === "POST" && req.url === "/pix/reservar") {
    await criarReservaPix(req, res, pool);
    return;
  }

  if (
    req.method === "GET" &&
    new URL(req.url, "http://localhost").pathname === "/pix/disponibilidade"
  ) {
    await consultarDisponibilidadePix(req, res, pool);
    return;
  }

  // PIX - Emissao autenticada da cobranca
  if (req.method === "POST" && req.url === "/pix/emitir") {
    await emitirPixDaReserva(req, res, pool);
    return;
  }

  // PIX - Consulta autenticada do pagamento
  if (req.method === "POST" && req.url === "/pix/status") {
    await consultarStatusPagamentoPix(req, res, pool);
    return;
  }

  if (req.method === "POST" && req.url === "/pix/agendamento/confirmacao") {
    await atenderConfirmacaoAgendamentoPix(req, res, pool);
    return;
  }

  // Mercado Pago - Webhook de Orders
  if (
    req.method === "POST" &&
    new URL(req.url, "http://localhost").pathname === "/pix/webhook"
  ) {
    await atenderWebhookPix(req, res, pool);
    return;
  }

  if (req.method !== "GET" || req.url !== "/health") {
    res.writeHead(404);
    res.end(
      JSON.stringify({
        erro: "Rota não encontrada",
      }),
    );
    return;
  }

  try {
    await pool.query("SELECT 1");

    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "online",
        banco: "PostgreSQL conectado",
        projeto: "Isabele Nails",
      }),
    );
  } catch (erro) {
    console.error("Falha na conexão com PostgreSQL:", erro.message);

    res.writeHead(503);
    res.end(
      JSON.stringify({
        status: "erro",
        banco: "PostgreSQL indisponível",
      }),
    );
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`API Isabele Nails iniciada na porta ${PORT}`);

  iniciarWorkerPush(pool);
  iniciarWorkerAgendamentoCancelamentos(pool);

  if (
    process.env.PIX_WEBHOOK_ENABLED === "true" &&
    process.env.PIX_WEBHOOK_WORKER_ENABLED === "true"
  ) {
    iniciarWorkerPixWebhook(pool);
  }

  // O polling permanece desativado até PIX_POLLING_WORKER_ENABLED=true.
  // Quando ativado, confirma pagamentos sem depender do navegador.
  iniciarWorkerPixPolling(pool);

  if (process.env.PIX_CALENDAR_WORKER_ENABLED === "true") {
    iniciarWorkerPixCalendar(pool, transportePixCalendar);
  }
  if (pixPagoReagendamentoHabilitado()) {
    iniciarWorkerReagendamentoPixPago(pool, transporteReagendamentoPix);
  }
  iniciarWorkerAlteracaoServico(pool, transporteAlteracaoServico);
  iniciarMonitorOportunidades(pool);

  iniciarMonitorAgendamentos(pool).catch((erro) => {
    console.error("Falha ao iniciar monitor de agendamentos:", erro);

    process.exit(1);
  });
});
