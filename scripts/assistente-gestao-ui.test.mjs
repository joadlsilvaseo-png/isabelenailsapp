import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (nome) => readFile(new URL("../" + nome, import.meta.url), "utf8");

test("Assistente aparece abaixo do perfil e antes da gestão profissional", async () => {
  const h = await read("principal.html"), j = await read("principal.js");
  assert.ok(h.indexOf('id="ig-home"') > h.indexOf('class="profile-card"'));
  assert.ok(h.indexOf('id="ig-home"') < h.indexOf('id="admin-principal-content"'));
  assert.match(h, /data-role-section="admin" aria-labelledby="ig-home-titulo"/);
  assert.match(j, /accessProfile\.role === "admin"/);
  assert.match(j, /iniciarAssistenteGestao\(\{ user, contexto: "home" \}\)/);
});
test("Acesso administrativo, leitura e preservação do preventivo", async () => {
  const j = await read("assistenteGestaoUI.js"), h = await read("admin-assistente.html");
  assert.match(j, /auth\.currentUser\?\.uid === user\.uid/);
  assert.match(j, /document\.body\.dataset\.userRole === "admin"/);
  assert.match(j, /document\.body\.dataset\.accessState === "allowed"/);
  assert.match(j, /Promise\.all/);
  assert.match(j, /\/api\/pix\/disponibilidade/);
  for (const acao of ["addDoc(", "updateDoc(", "deleteDoc(", "setDoc(", "runTransaction("]) {
    assert.equal(j.includes(acao), false, acao);
  }
  assert.match(h, /data-ig-contexto="detalhe"/);
  assert.match(h, /id="ig-radar"/);
  assert.match(h, /id="ig-semana"/);
  assert.match(h, /id="assistente-form"/);
});
test("WhatsApp é manual, mensagens são renderizadas como texto", async () => {
  const j = await read("assistenteGestaoUI.js");
  assert.match(j, /Abrir WhatsApp/);
  assert.match(j, /Copiar mensagem/);
  assert.match(j, /noopener noreferrer/);
  assert.match(j, /navigator\.clipboard\.writeText/);
  assert.match(j, /textContent/);
});
