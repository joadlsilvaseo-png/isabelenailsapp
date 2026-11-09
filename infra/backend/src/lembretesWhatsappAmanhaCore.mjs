/** Regras puras do lembrete manual de amanha. Nenhum envio automatico. */
import { createHash } from "node:crypto";

const ATIVOS = new Set(["agendado", "confirmado", "reagendado"]);
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ASSINATURA = /^[a-f0-9]{64}$/;

function texto(valor, max = 160) {
  return String(valor ?? "").trim().slice(0, max);
}
function primeiro(dados, campos) {
  for (const campo of campos) {
    const valor = texto(dados?.[campo]);
    if (valor) return valor;
  }
  return "";
}

export function amanhaSaoPaulo(agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(agora);
  const valores = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return new Date(Date.UTC(
    Number(valores.year), Number(valores.month) - 1, Number(valores.day) + 1,
  )).toISOString().slice(0, 10);
}

export function normalizarTelefoneWhatsapp(valor) {
  let numero = String(valor ?? "").replace(/\D/g, "");
  if (/^\d{10,11}$/.test(numero)) numero = "55" + numero;
  return /^55\d{10,11}$/.test(numero) ? numero : "";
}

export function validarMarcacao(dados) {
  return dados && typeof dados === "object" && !Array.isArray(dados) &&
    typeof dados.agendamentoId === "string" && ID.test(dados.agendamentoId) &&
    typeof dados.assinatura === "string" && ASSINATURA.test(dados.assinatura);
}

export function normalizarLembrete({ id, agendamento, cliente = {}, data }) {
  if (!ID.test(String(id ?? "")) || !DATA.test(String(data ?? ""))) return null;
  const atual = agendamento || {};
  const status = texto(atual.status, 60).toLowerCase();
  const dataAtual = primeiro(atual, ["data", "dataAgendamento", "date"]);
  const horario = primeiro(atual, ["horario", "hora", "time"]).slice(0, 5);
  if (!ATIVOS.has(status) || dataAtual !== data || !HORA.test(horario)) return null;

  const clienteUid = primeiro(atual, ["clienteId", "idCliente", "uidCliente", "userId", "usuarioId"]);
  const nome = primeiro(cliente, ["nome", "nomeCliente", "name"]) ||
    primeiro(atual, ["nomeCliente", "clienteNome", "nome"]) || "Cliente";
  const telefone = normalizarTelefoneWhatsapp(
    primeiro(cliente, ["telefone", "celular", "whatsapp", "phone"])
  );
  const servico = primeiro(atual, ["servico", "nomeServico", "servicoNome"]) ||
    "Serviço agendado";
  const servicoId = primeiro(atual, ["idServico", "servicoId"]);
  const duracao = Number(primeiro(atual, ["duracaoSnapshot", "duracao", "duracaoMinutos"]) || 0);
  // A assinatura muda com reagendamento, mudanca de servico ou telefone.
  // Nunca usar somente agendamento_id para considerar um lembrete enviado.
  const assinatura = createHash("sha256").update(JSON.stringify([
    id, clienteUid, data, horario, servicoId, servico,
    Number.isFinite(duracao) ? duracao : 0, telefone,
  ])).digest("hex");
  return {
    agendamentoId: id, nome, data, horario, servico, telefone,
    assinatura, possuiTelefone: Boolean(telefone),
  };
}

export function resumoLembretes(itens) {
  return {
    total: itens.length,
    pendentes: itens.filter((i) => i.possuiTelefone && !i.marcadoEnviado).length,
    marcados: itens.filter((i) => i.marcadoEnviado).length,
    semTelefone: itens.filter((i) => !i.possuiTelefone).length,
  };
}
