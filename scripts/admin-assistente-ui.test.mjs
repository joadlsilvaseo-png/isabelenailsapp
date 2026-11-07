import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (nome) => readFile(new URL("../" + nome, import.meta.url), "utf8");
test("assistente usa linguagem preventiva e mostra motivo real da API",async()=>{
  const h=await read("admin-assistente.html"),j=await read("admin-assistente.js");
  for(const t of ["Encaixes excepcionais","oportunidades de encaixe","Quais encaixes temos"]){
    assert.equal((h+j).toLowerCase().includes(t.toLowerCase()),false,t);
  }
  assert.match(h,/Nenhum horário é bloqueado automaticamente/);
  assert.match(j,/item\.justificativa/);
  assert.match(j,/item\.servicosElegiveis/);
  assert.match(j,/Nenhum bloqueio é feito automaticamente/);
});
test("links e acesso administrativo preservados",async()=>{
  const h=await read("admin-assistente.html"),j=await read("admin-assistente.js");
  const n=await read("admin-bottom-nav.js"),c=await read("admin-bottom-nav.css");
  assert.match(h,/aria-label="Voltar para Gestão"/);
  assert.match(h,/admin-assistente\.css\?v=3/);
  assert.match(h,/admin-assistente\.js\?v=4/);
  assert.match(h,/admin-bottom-nav\.js/);
  assert.match(j,/admin-calendario\.html\?data=/);
  assert.match(j,/encodeURIComponent\(item\.data\)/);
  assert.match(j,/perfil\.data\(\)\.role!=="admin"/);
  assert.match(j,/document\.body\.dataset\.accessState="loading"/);
  assert.match(n,/paginaAtual !== "admin-assistente"/);
  assert.match(c,/body\[data-page="admin-assistente"\]\[data-access-state="allowed"\]/);
  for (const id of ["assistente-acesso","assistente-conteudo","assistente-dialogo","assistente-form","assistente-pergunta","assistente-enviar"]) assert.ok(h.includes('id="'+id+'"'),id);
});
