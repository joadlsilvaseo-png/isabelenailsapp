import test from "node:test";
import assert from "node:assert/strict";
import {
  validarServicoCatalogo, servicoCatalogoDaUrl, loginComServico,
  registroComServico, principalComServico, agendamentoComServico
} from "../catalogoEntrada.mjs";

test("preserva serviço entre login, cadastro, principal e agendamento", () => {
  const id = "manutencao unha 2026";
  const login = loginComServico(id);
  assert.equal(login, "login.html?servico=manutencao%20unha%202026");
  assert.equal(servicoCatalogoDaUrl(new URL(login,"https://isabelenailsapp.vercel.app").search), id);
  assert.equal(registroComServico(id), "registro.html?servico=manutencao%20unha%202026");
  assert.equal(principalComServico(id), "principal.html?servico=manutencao%20unha%202026");
  assert.equal(agendamentoComServico(id), "agendamento.html?id=manutencao%20unha%202026");
});
test("sem serviço, mantém o fluxo normal do app", () => {
  assert.equal(loginComServico(""), "login.html");
  assert.equal(registroComServico(""), "registro.html");
  assert.equal(principalComServico(""), "principal.html");
  assert.equal(agendamentoComServico(""), "principal.html#services-title");
  assert.equal(servicoCatalogoDaUrl(""), "");
});
test("não permite URL externa nem segmentos de caminho como serviço", () => {
  for(const id of ["https://example.com","../../logout","x/y","x\\y","evil?next=x","", " ".repeat(2), "a".repeat(301)]){
    assert.equal(validarServicoCatalogo(id), "");
    assert.equal(loginComServico(id), "login.html");
  }
  assert.equal(servicoCatalogoDaUrl("?servico=abc123"), "abc123");
  assert.equal(servicoCatalogoDaUrl("?servico=..%2F..%2Flogout"), "");
});
