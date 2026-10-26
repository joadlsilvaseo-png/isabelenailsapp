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
import { consultarDisponibilidadePix } from "./pixDisponibilidadeApi.js";
import { atenderGerenciarCalendario } from "./agendaBloqueios.js";
import { atenderGestaoClientes } from "./gestaoClientes.js";
import { atenderFotosPerfil } from "./fotosPerfil.js";

const { Pool } = pg;

const pool = new Pool();
const PORT = Number(process.env.PORT || 3001);

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error("Chaves VAPID não configuradas no servidor.");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

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

  if (
    [
      "/agendamentos/isencao",
      "/agendamentos/sem-pix",
      "/agendamentos/reagendar",
      "/admin/isencoes-sinal-pix",
      "/admin/clientes/isencao-sinal-pix",
    ].includes(new URL(req.url, "http://localhost").pathname)
  ) {
    await atenderAgendamentoIsencao(req, res, pool);
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
    iniciarWorkerPixCalendar(pool);
  }

  iniciarMonitorAgendamentos(pool).catch((erro) => {
    console.error("Falha ao iniciar monitor de agendamentos:", erro);

    process.exit(1);
  });
});
