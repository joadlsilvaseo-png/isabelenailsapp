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

test("terça: grade administrativa de 30min orienta limites da janela de 15min", () => {
  const data = "2026-11-03";
  for (const horario of ["14:00", "14:30", "15:00", "15:30"]) {
    assert.equal(tipo(data, inicio(horario)), "livre", horario);
  }
  for (const horario of ["16:00", "16:30", "17:00"]) {
    assert.equal(tipo(data, inicio(horario)), "inicio-limitado", horario);
    assert.ok(listarSlotsGerenciaveis(data, AGORA).includes(inicio(horario)), horario);
  }
  assert.equal(tipo(data, inicio("17:30")), "sem-inicio");
});

test("quarta: janelas contínuas, incluindo 9h30 e 14h30, sem alterar bloqueios", () => {
  const data = "2026-11-04";
  for (const horario of ["09:00", "09:30", "10:00", "10:30", "14:00", "14:30", "15:00", "15:30"]) {
    assert.equal(tipo(data, inicio(horario)), "livre", horario);
  }
  for (const horario of ["11:00", "11:30", "12:00", "16:00", "16:30", "17:00"]) {
    assert.equal(tipo(data, inicio(horario)), "inicio-limitado", horario);
    assert.ok(listarSlotsGerenciaveis(data, AGORA).includes(inicio(horario)), horario);
  }
  assert.equal(tipo(data, inicio("13:30")), "sem-inicio");
  assert.equal(obterRegraVisualDoIntervalo(data, inicio("09:00")).duracoesPermitidas.at(-1), 210);
  assert.equal(obterRegraVisualDoIntervalo(data, inicio("10:30")).duracoesPermitidas.at(-1), 120);
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

test("sábado permite 15min sem perder exceção 16h/150min", () => {
  const data = "2026-11-07";
  assert.equal(tipo(data, inicio("09:00")), "livre");
  for (const horario of ["15:00", "15:30"]) {
    assert.equal(tipo(data, inicio(horario)), "livre", horario);
  }
  for (const horario of ["16:00", "16:30", "17:00", "17:30"]) {
    assert.equal(tipo(data, inicio(horario)), "inicio-limitado", horario);
  }
  const duracoes16 = obterRegraVisualDoIntervalo(data, inicio("16:00")).duracoesPermitidas;
  assert.ok(duracoes16.includes(120));
  assert.ok(duracoes16.includes(150));
  assert.ok(!duracoes16.includes(149));
  assert.equal(obterRegraVisualDoIntervalo(data, inicio("16:30")).duracoesPermitidas.at(-1), 90);
  assert.equal(tipo(data, inicio("18:00")), "sem-inicio");
  assert.ok(listarSlotsGerenciaveis(data, AGORA).includes(inicio("18:00")));
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
