// Smoke estatico do lembrete manual do Assistente Isabele.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const ler = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = ler("../principal.html");
const ui = ler("../assistenteLembretesWhatsappUI.js");
const assistente = ler("../assistenteGestaoUI.js");
const servidor = ler("../infra/backend/src/server.js");
const api = ler("../infra/backend/src/lembretesWhatsappAmanha.js");

test("home exibe sinalizacao admin e abre modal sem nova tela", () => {
  const inicio = html.indexOf('id="ig-home"');
  const fim = html.indexOf('id="principal-push-card"');
  const card = html.indexOf("data-ig-lembretes-abrir");
  assert.ok(inicio >= 0 && card > inicio && card < fim);
  assert.match(html, /id="ig-lembretes-dialog"/);
  assert.match(html, /data-ig-lembretes-sinal/);
  assert.match(html, /data-ig-lembretes-lista/);
  assert.match(html, /assistenteGestao\.css\?v=4/);
  assert.match(assistente, /import\("\.\/assistenteLembretesWhatsappUI\.js\?v=3"\)/);
});

test("UI exige envio manual no WhatsApp e nao possui endpoint de disparo", () => {
  assert.match(ui, /linkWhatsApp\(item\.telefone, mensagem\(item\)\)/);
  assert.match(ui, /window\.confirm\(/);
  assert.match(ui, /method: marcar \? "POST" : "DELETE"/);
  assert.doesNotMatch(ui, /sendNotification|\/messages|cloud-api|webpush\.send/i);
});

test("rota separada so para admin, Firestore atual e PostgreSQL para marcacoes", () => {
  assert.match(servidor, /atenderLembretesWhatsappAmanha\(req, res, pool\)/);
  assert.match(api, /admin\.data\(\)\?\.role !== "admin"/);
  assert.match(api, /agendamentoSnap\.data\(\)/);
  assert.match(api, /item\.assinatura !== dados\.assinatura/);
  assert.match(api, /ON CONFLICT \(agendamento_id, assinatura\) DO NOTHING/);
  assert.doesNotMatch(api, /whatsapp\.com\/send|graph\.facebook\.com|sendNotification/);
});

test("mensagem usa o texto aprovado com nome, horario e servico dinamicos", () => {
  const inicio = ui.indexOf("function mensagem(item)");
  const fim = ui.indexOf("\nfunction autorizado", inicio);
  assert.ok(inicio >= 0 && fim > inicio);
  const trecho = ui.slice(inicio, fim);
  const gerarMensagem = runInNewContext(trecho + "\nmensagem");

  const exemplo = gerarMensagem({
    nome: "Mariana Souza", horario: "14:00", servico: "Banho de Gel",
  });
  assert.equal(exemplo, [
    "Oi, Mariana! 💅✨",
    "",
    "Passando para lembrar que você tem um horário agendado para amanhã, às *14h*, para o serviço de Banho de Gel.",
    "",
    "Esperamos você! ❤️",
    "",
    "_Isabele Mariana Nails_",
  ].join("\n"));

  const outroHorario = gerarMensagem({
    nome: "Carla Lima", horario: "17:30", servico: "Manicure",
  });
  assert.match(outroHorario, /Carla!/);
  assert.match(outroHorario, /às \*17h30\*/);
  assert.match(outroHorario, /serviço de Manicure/);
  assert.match(ler("../assistenteGestaoCore.mjs"), /encodeURIComponent\(mensagem\)/);
});
