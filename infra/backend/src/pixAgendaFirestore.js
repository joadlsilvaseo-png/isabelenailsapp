import {
  initializeApp,
  applicationDefault,
  getApps,
} from "firebase-admin/app";

import { getFirestore } from "firebase-admin/firestore";

import { possuiSobreposicao } from "./pixDisponibilidade.js";

const STATUS_OCUPADOS = new Set([
  "agendado",
  "reagendado",
  "confirmado",
]);

function obterBancoFirestore() {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: "isabele-nails-app",
    });
  }

  return getFirestore();
}

export async function verificarConflitoFirestore(
  dataIso,
  inicioMinuto,
  fimMinuto,
) {
  if (
    typeof dataIso !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dataIso) ||
    !Number.isInteger(inicioMinuto) ||
    !Number.isInteger(fimMinuto) ||
    inicioMinuto < 0 ||
    fimMinuto > 1440 ||
    inicioMinuto >= fimMinuto
  ) {
    throw new Error("Periodo invalido para consulta");
  }

  const banco = obterBancoFirestore();

  const resultado = await banco
    .collection("agendamentos")
    .where("data", "==", dataIso)
    .get();

  const intervalosOcupados = [];

  resultado.forEach((documento) => {
    const dados = documento.data();

    if (!STATUS_OCUPADOS.has(dados.status)) {
      return;
    }

    if (
      typeof dados.horario !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(dados.horario)
    ) {
      throw new Error(
        "Agendamento ativo com horario invalido",
      );
    }

    const [horas, minutos] = dados.horario
      .split(":")
      .map(Number);

    const inicio = horas * 60 + minutos;

    const duracao = Number(dados.duracao) || 90;

    if (
      !Number.isFinite(duracao) ||
      duracao <= 0 ||
      duracao > 1440
    ) {
      throw new Error(
        "Agendamento ativo com duracao invalida",
      );
    }

    intervalosOcupados.push({
      inicioMinuto: inicio,
      fimMinuto: inicio + duracao,
    });
  });

  return {
    ocupado: possuiSobreposicao(
      inicioMinuto,
      fimMinuto,
      intervalosOcupados,
    ),
    quantidadeAgendamentosAtivos: intervalosOcupados.length,
  };
}