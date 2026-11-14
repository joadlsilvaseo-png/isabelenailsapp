import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { obterRegraVisualDoIntervalo } from "../admin-calendario-regras.mjs";
import { listarSlotsGerenciaveis } from "../infra/backend/src/agendamentoRegras.mjs";

const AGORA = new Date("2026-11-02T14:30:00-03:00");
const tipo = (data, hora) => obterRegraVisualDoIntervalo(data, hora).tipo;
const inicio = (horario) => {
  const [h, m] = horario.split(":").map(Number);
  return h * 60 + m;
};

test("domingo e segunda não oferecem intervalos administráveis", () => {
  for (const data of ["2026-11-08", "2026-11-09"]) {
    assert.deepEqual(listarSlotsGerenciaveis(data, AGORA), []);
    assert.equal(tipo(data, inicio("14:00")), "sem-inicio");
  }
});

test("terça permite início de 15 min durante a janela comercial, sem criar novos períodos",()=>{
  const data="2026-11-03";
  for(const h of ["14:00","14:30","15:00","15:30","16:00","17:00"]) {
    assert.equal(tipo(data,inicio(h)),"inicio-limitado",h);
  }
  for(const h of ["13:30","17:30"]) assert.equal(tipo(data,inicio(h)),"sem-inicio",h);
  assert.ok(listarSlotsGerenciaveis(data,AGORA).includes(inicio("16:00")));
});

test("quarta preserva duas janelas e valida inícios de hora e meia hora no painel",()=>{
  const data="2026-11-04";
  for(const h of ["09:00","09:30","10:00","10:30","11:00","11:30","12:00","14:00","14:30","15:00","15:30","17:00"]) {
    assert.equal(tipo(data,inicio(h)),"inicio-limitado",h);
    assert.ok(listarSlotsGerenciaveis(data,AGORA).includes(inicio(h)),h);
  }
  for(const h of ["08:30","12:30","13:30","17:30"]) assert.equal(tipo(data,inicio(h)),"sem-inicio",h);
  assert.equal(obterRegraVisualDoIntervalo(data,inicio("09:00")).duracoesPermitidas.length,210);
  assert.equal(obterRegraVisualDoIntervalo(data,inicio("10:30")).duracoesPermitidas.length,120);
});

test("quinta e sexta têm início até 20h30, limite de 21h e não possuem pausa fixa", () => {
  for (const [data, abertura] of [["2026-11-05", "11:00"], ["2026-11-06", "09:00"]]) {
    assert.equal(tipo(data, inicio(abertura)), "livre");
    assert.equal(tipo(data, inicio("13:30")), "livre"); // almoço é manual
    for (const horario of ["17:30", "18:00", "18:30", "19:00"]) {
      assert.equal(tipo(data, inicio(horario)), "livre", horario);
    }
    for (const [horario, duracaoMaxima] of [["19:30", 90], ["20:00", 60], ["20:30", 30]]) {
      const regra = obterRegraVisualDoIntervalo(data, inicio(horario));
      assert.equal(regra.tipo, "inicio-limitado", horario);
      assert.equal(regra.duracoesPermitidas.length, duracaoMaxima, horario);
    }
    assert.equal(tipo(data, inicio("21:00")), "sem-inicio");
    const slots = listarSlotsGerenciaveis(data, AGORA);
    assert.ok(slots.includes(inicio("20:30")));
    assert.ok(!slots.includes(inicio("21:00")));
  }
});

test("sábado aceita duração real até 18h, mantendo exceção única às 16h",()=>{
  const data="2026-11-07";
  assert.equal(tipo(data,inicio("09:00")),"livre");
  for(const h of ["15:00","15:30","16:00","16:30","17:00","17:30"]) {
    assert.equal(tipo(data,inicio(h)),"inicio-limitado",h);
  }
  const r16=obterRegraVisualDoIntervalo(data,inicio("16:00")).duracoesPermitidas;
  assert.ok(r16.includes(150));
  assert.equal(r16.includes(151),false);
  assert.equal(obterRegraVisualDoIntervalo(data,inicio("16:30")).duracoesPermitidas.length,90);
  assert.equal(tipo(data,inicio("18:00")),"sem-inicio");
  assert.ok(listarSlotsGerenciaveis(data,AGORA).includes(inicio("18:00"))); // fechamento da exceção
});

test("a regra visual não altera fechamento nem abertura de intervalos", async () => {
  const front = await readFile(new URL("../admin-calendario.js", import.meta.url), "utf8");
  const backend = await readFile(new URL("../infra/backend/src/agendaBloqueios.js", import.meta.url), "utf8");
  assert.match(front, /const reservado = estaOcupado\(minuto\)/);
  assert.match(front, /const fechado = estaFechado\(minuto\)/);
  assert.match(front, /botao\.disabled = estado\.carregando \|\| estado\.salvando \|\| reservado \|\| !elegivel/);
  assert.match(backend, /INSERT INTO public\.agenda_bloqueios/);
  assert.match(backend, /DELETE FROM public\.agenda_bloqueios/);
});

test("entradas inválidas e horários sem expediente são tratados como sem início", () => {
  assert.equal(tipo("2026-11-05", inicio("10:30")), "sem-inicio");
  assert.equal(tipo("2026-11-05", inicio("21:00")), "sem-inicio");
  assert.equal(tipo("2026-11-31", inicio("11:00")), "sem-inicio");
  assert.equal(tipo("2026-11-05", 665), "sem-inicio");
});

test("service worker permite somente deep link estrito do calendário com data e atualiza cache", async () => {
  const worker = await readFile(new URL("../service-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const CACHE_VERSION = "v\d+"/);
  assert.ok(worker.includes(String.raw`/^\.\/admin-calendario\.html\?data=\d{4}-\d{2}-\d{2}$/`));
  assert.match(worker, /destinoAgendaAdministrativa \|\| destinoPaginaExistente/);
});


test("PWA atualizado negocia cutover no backend e nao duplica GAS em reagendamento direto", async()=>{
  const front=await readFile(new URL("../agendamento.js",import.meta.url),"utf8");
  const html=await readFile(new URL("../agendamento.html",import.meta.url),"utf8");
  const worker=await readFile(new URL("../service-worker.js",import.meta.url),"utf8");
  assert.match(front,/calendarClientSupportsBackend:\s*true/);
  assert.match(front,/let operationId = sessionStorage\.getItem\(operacaoKey\)/);
  assert.match(front,/sessionStorage\.removeItem\(operacaoKey\)/);
  const verificarDireto=front.indexOf("resultadoReagendamento.calendarDiretoHabilitado === true");
  const enviarLegado=front.indexOf("const googleScriptUrl =");
  assert.ok(verificarDireto>0 && enviarLegado>verificarDireto,
    "O PWA deve verificar o backend ANTES de oferecer o fallback GAS");
  assert.match(front,/resultadoReagendamento\.sincronizacaoCalendar === "pendente"/);
  assert.match(html,/agendamento\.js\?v=\d+(?:\.\d+)+/);
  assert.match(worker,/const CACHE_VERSION = "v32"/);
});
