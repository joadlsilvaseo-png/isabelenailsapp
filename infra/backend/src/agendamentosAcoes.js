import {
  initializeApp,
  applicationDefault,
  getApps
} from "firebase-admin/app";

import {
  getFirestore,
  FieldValue
} from "firebase-admin/firestore";

import { verificarUsuario } from "./pushSubscriptions.js";
import { pagamentoPixConfirmadoManualmente } from "./pixRegrasConfirmacao.js";

const ACOES = new Set([
  "cancelar_cliente",
  "confirmar_admin",
  "concluir_admin",
  "cancelar_admin"
]);

const STATUS_ATIVOS = new Set([
  "agendado",
  "reagendado",
  "confirmado"
]);

class ErroAcao extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

function responder(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(dados));
}

function bancoFirestore() {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: "isabele-nails-app"
    });
  }

  return getFirestore();
}

async function lerCorpo(req) {
  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > 8192) {
      throw new ErroAcao(413, "Requisicao muito grande");
    }

    partes.push(parte);
  }

  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8"));
  } catch {
    throw new ErroAcao(400, "JSON invalido");
  }
}

function validarValorFinal(valor) {
  if (
    typeof valor !== "number" ||
    !Number.isFinite(valor) ||
    valor <= 0
  ) {
    throw new ErroAcao(400, "Valor final invalido");
  }

  const centavos = Math.round(valor * 100);

  if (
    !Number.isSafeInteger(centavos) ||
    Math.abs(centavos / 100 - valor) > 1e-9
  ) {
    throw new ErroAcao(400, "Valor final invalido");
  }

  return centavos / 100;
}

export async function atenderAcaoAgendamento(req, res) {
  let uid;

  try {
    uid = await verificarUsuario(req);
  } catch {
    responder(res, 401, { erro: "Nao autenticado" });
    return;
  }

  try {
    const dados = await lerCorpo(req);

    const { agendamentoId, acao } = dados ?? {};

    if (
      typeof agendamentoId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(agendamentoId) ||
      !ACOES.has(acao)
    ) {
      throw new ErroAcao(400, "Acao ou agendamento invalido");
    }

    const db = bancoFirestore();
    const referencia = db.collection("agendamentos").doc(agendamentoId);
    const acaoAdmin = acao.endsWith("_admin");

    const resultado = await db.runTransaction(async (transacao) => {
      if (acaoAdmin) {
        const perfilRef = db.collection("usuarios").doc(uid);
        const perfilSnap = await transacao.get(perfilRef);

        if (
          !perfilSnap.exists ||
          perfilSnap.data().role !== "admin" ||
          perfilSnap.data().ativo !== true
        ) {
          throw new ErroAcao(403, "Acesso administrativo negado");
        }
      }

      const snap = await transacao.get(referencia);

      if (!snap.exists) {
        throw new ErroAcao(404, "Agendamento nao encontrado");
      }

      const agendamento = snap.data();
      const statusAtual = agendamento.status;

      if (!acaoAdmin && agendamento.clienteId !== uid) {
        throw new ErroAcao(403, "Agendamento nao pertence ao usuario");
      }

      let novoStatus;
      const atualizacoes = {
        atualizadoEm: FieldValue.serverTimestamp(),
        atualizadoPor: uid
      };

      if (acao === "cancelar_cliente") {
        if (!STATUS_ATIVOS.has(statusAtual)) {
          throw new ErroAcao(409, "Cancelamento nao permitido");
        }

        if (pagamentoPixConfirmadoManualmente(agendamento)) {
          throw new ErroAcao(
            409,
            "Agendamento com PIX requer tratamento financeiro"
          );
        }

        novoStatus = "cancelado_cliente";
        atualizacoes.canceladoEm = FieldValue.serverTimestamp();
      }

      if (acao === "confirmar_admin") {
        if (agendamento.pixCobrancaId || agendamento.pixPagamentoId) {
          throw new ErroAcao(409, "Agendamento PIX confirmado automaticamente apos conciliacao financeira");
        }
        if (!["agendado", "reagendado"].includes(statusAtual)) {
          throw new ErroAcao(409, "Agendamento nao pode ser confirmado");
        }

        novoStatus = "confirmado";
        atualizacoes.confirmadoEm = FieldValue.serverTimestamp();
      }

      if (acao === "concluir_admin") {
        if (!["confirmado", "reagendado"].includes(statusAtual)) {
          throw new ErroAcao(409, "Agendamento nao pode ser concluido");
        }

        novoStatus = "concluido";
        atualizacoes.valorFinal = validarValorFinal(dados.valorFinal);
        atualizacoes.concluidoEm = FieldValue.serverTimestamp();
      }

      if (acao === "cancelar_admin") {
        if (!STATUS_ATIVOS.has(statusAtual)) {
          throw new ErroAcao(409, "Cancelamento nao permitido");
        }

        if (agendamento.pixCobrancaId || agendamento.pixPagamentoId) {
          throw new ErroAcao(
            409,
            "Agendamento com PIX requer tratamento financeiro"
          );
        }

        novoStatus = "cancelado_profissional";
        atualizacoes.canceladoEm = FieldValue.serverTimestamp();
      }

      atualizacoes.status = novoStatus;
      transacao.update(referencia, atualizacoes);

      return { agendamentoId, status: novoStatus };
    });

    responder(res, 200, {
      sucesso: true,
      ...resultado
    });
  } catch (erro) {
    if (erro instanceof ErroAcao) {
      responder(res, erro.status, { erro: erro.message });
      return;
    }

    console.error("[Agendamentos] Falha:", erro.message);

    responder(res, 500, {
      erro: "Nao foi possivel atualizar o agendamento"
    });
  }
}
