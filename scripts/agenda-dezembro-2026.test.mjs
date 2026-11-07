import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  obterExpedienteEspecialDezembro2026,
  AGENDA_DEZEMBRO_2026_ABERTA,
  validarDataNaJanela,
  validarHorarioEspecial,
  validarServicoDezembro2026,
  listarSlotsGerenciaveis,
} from "../infra/backend/src/agendamentoRegras.mjs";
import { validarHorarioPix } from "../infra/backend/src/pixDisponibilidade.js";
import { obterRegraVisualDoIntervalo } from "../admin-calendario-regras.mjs";

const AGORA = new Date("2026-11-02T15:00:00-03:00");
const dataDia = dia => `2026-12-${String(dia).padStart(2, "0")}`;
const hora = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

test("dezembro está aberto ao agendamento público exceto nos dias de fechamento", () => {
  assert.equal(AGENDA_DEZEMBRO_2026_ABERTA, true);
  const fechados = new Set([6, 7, 13, 15, 25, 26, 27, 31]);
  for (let dia = 1; dia <= 31; dia++) {
    const data = dataDia(dia);
    const disponivel = !fechados.has(dia);
    assert.equal(validarDataNaJanela(data, AGORA).valido, disponivel, data);
    assert.equal(validarHorarioPix(data, "14:00", 60, AGORA).valido, disponivel, data);
  }
});

test("dias marcados com X e terça 15/12 não possuem expediente nem slots administrativos", () => {
  for (const dia of [6, 7, 13, 15, 25, 26, 27, 31]) {
    const data = dataDia(dia);
    assert.equal(obterExpedienteEspecialDezembro2026(data).aberto, false, data);
    assert.deepEqual(listarSlotsGerenciaveis(data, AGORA), [], data);
    assert.equal(validarHorarioEspecial(data, "14:00", 60), false, data);
  }
});

test("1 a 13/12 preservam expedientes e regras dos dias habituais", () => {
  assert.equal(obterExpedienteEspecialDezembro2026("2026-12-01"), null);
  assert.equal(validarHorarioEspecial("2026-12-01", "14:00", 60), true);
  assert.equal(validarHorarioEspecial("2026-12-01", "15:30", 60), true);
  assert.deepEqual(listarSlotsGerenciaveis("2026-12-01", AGORA).slice(0, 2), [840, 855]);
  assert.equal(validarHorarioEspecial("2026-12-02", "09:00", 150), true);
  assert.equal(validarHorarioEspecial("2026-12-02", "09:30", 60), true);
  assert.equal(validarHorarioEspecial("2026-12-03", "10:30", 60), false); // Quinta abre às 11h.
  assert.equal(validarHorarioEspecial("2026-12-05", "16:00", 150), true);
  assert.equal(validarHorarioEspecial("2026-12-05", "16:30", 60), true);
  assert.equal(validarHorarioEspecial("2026-12-08", "14:30", 120), true);
  assert.equal(validarHorarioEspecial("2026-12-09", "10:30", 90), true);
  assert.equal(validarHorarioEspecial("2026-12-12", "17:30", 30), true);
  // Regras semanais não foram alteradas para outros meses.
  assert.equal(validarHorarioEspecial("2026-11-03", "15:30", 60), true);
  assert.equal(validarHorarioEspecial("2027-01-06", "10:00", 120), true);
});

test("quinta e sexta comuns terminam às 21h, mas exceções 17 e 18/12 continuam às 20h", () => {
  for (const data of ["2026-12-03", "2026-12-04", "2026-12-10", "2026-12-11"]) {
    assert.equal(obterExpedienteEspecialDezembro2026(data), null);
    assert.equal(validarHorarioPix(data, "20:30", 30, AGORA).valido, true, data);
    assert.equal(validarHorarioPix(data, "21:00", 30, AGORA).valido, false, data);
  }
  for (const data of ["2026-12-17", "2026-12-18"]) {
    assert.equal(obterExpedienteEspecialDezembro2026(data).encerramentoMinuto, 1200);
    assert.equal(validarHorarioPix(data, "19:30", 30, AGORA).valido, true, data);
    assert.equal(validarHorarioPix(data, "19:30", 60, AGORA).valido, false, data);
    assert.equal(validarHorarioPix(data, "20:00", 30, AGORA).valido, false, data);
  }
});

test("14 e 16 a 24 e 28 a 30 seguem abertura/encerramento excepcionais exatos", () => {
  const faixas = new Map([
    [14, [540, 1200]], [16, [780, 1200]], [17, [540, 1200]],
    [18, [540, 1200]], [19, [420, 1320]], [20, [420, 1320]],
    [21, [420, 1320]], [22, [420, 1320]], [23, [420, 1320]],
    [24, [420, 960]], [28, [540, 1200]], [29, [540, 1200]],
    [30, [540, 1200]],
  ]);
  for (const [dia, [abertura, fechamento]] of faixas) {
    const data = dataDia(dia);
    assert.deepEqual(obterExpedienteEspecialDezembro2026(data), {
      aberto: true, inicioMinuto: abertura, encerramentoMinuto: fechamento,
    }, data);
    const slots = listarSlotsGerenciaveis(data, AGORA);
    assert.equal(slots[0], abertura, data);
    assert.equal(slots.at(-1), fechamento - 15, data);
    assert.equal(validarHorarioEspecial(data, hora(abertura), 60), true, data);
    assert.equal(validarHorarioEspecial(data, hora(abertura - 30), 60), false, data);
    assert.equal(validarHorarioEspecial(data, hora(fechamento - 60), 60), true, data);
    assert.equal(validarHorarioEspecial(data, hora(fechamento - 30), 60), false, data);
    assert.equal(validarHorarioEspecial(data, hora(fechamento - 30), 30), true, data);
  }
});

test("domingo 20, segunda 14/21/28 e quarta 16 são exceções reais", () => {
  for (const dia of [14, 20, 21, 28]) {
    assert.ok(listarSlotsGerenciaveis(dataDia(dia), AGORA).length > 0);
  }
  assert.equal(validarHorarioEspecial("2026-12-16", "12:30", 30), false);
  assert.equal(validarHorarioEspecial("2026-12-16", "13:00", 60), true);
  assert.equal(obterRegraVisualDoIntervalo("2026-12-20", 420).tipo, "inicio-limitado"); // Restrição de pedicure.
  assert.equal(obterRegraVisualDoIntervalo("2026-12-16", 750).tipo, "sem-inicio");
});

test("pedicure simples/em gel suspensas de 17 a 23 e retornam 28 a 30", () => {
  const simples = { nome: "Pedicure Simples", categoria: "Pedicure" };
  const gel = { nome: "Esmaltação em Gel", categoria: "Pedicure" };
  const manicure = { nome: "Manicure Simples", categoria: "Manicure" };
  assert.equal(validarServicoDezembro2026("2026-12-16", simples).valido, true);
  for (let dia = 17; dia <= 23; dia++) {
    const data = dataDia(dia);
    assert.equal(validarServicoDezembro2026(data, simples).valido, false, data);
    assert.equal(validarServicoDezembro2026(data, gel).valido, false, data);
    assert.equal(validarServicoDezembro2026(data, manicure).valido, true, data);
    assert.equal(obterRegraVisualDoIntervalo(data, 840).tipo, "inicio-limitado", data);
  }
  for (const dia of [28, 29, 30]) {
    assert.equal(validarServicoDezembro2026(dataDia(dia), gel).valido, true);
    assert.equal(validarServicoDezembro2026(dataDia(dia), simples).valido, true);
  }
});

test("24/12 permite manutenções de unhas, aplicações e manicures; pedicure segue proibida", () => {
  const permitidos = [
    ["Alongamento em Fibra de Vidro", "Unhas em Gel"],
    ["Aplicação de Alongamento", "Unhas em Gel"],
    ["Banho de Gel", "Unhas em Gel"],
    ["Manicure Simples", "Manicure"],
    ["Manicure em Gel", "Manicure"],
    ["Esmaltação em Gel", "Manicure"],
    ["Manutenção Banho de Gel", "Unhas em Gel"],
    ["Manutenção de Banho de Gel", "Unhas em Gel"],
    ["Manutenção Alongamento em Fibra", "Unhas em Gel"],
    ["Manutenção em Gel", "Unhas em Gel"],
    ["MANUTENÇÃO DE ALONGAMENTO", "Unhas em Gel"],
  ];
  const proibidos = [
    ["Pedicure Simples", "Pedicure"],
    ["Esmaltação em Gel", "Pedicure"],
    ["Manutenção Pedicure em Gel", "Pedicure"],
    ["Manutenção e Remoção de Alongamento", "Unhas em Gel"],
    ["Blindagem", "Unhas em Gel"],
    ["Remoção de Alongamento", "Unhas em Gel"],
  ];
  for (const [nome, categoria] of permitidos) {
    assert.equal(validarServicoDezembro2026("2026-12-24", {nome, categoria}).valido,
      true, nome);
  }
  for (const [nome, categoria] of proibidos) {
    assert.equal(validarServicoDezembro2026("2026-12-24", {nome, categoria}).valido,
      false, nome);
  }
  // A nova permissão comercial não estende o expediente de 07h às 16h.
  assert.equal(validarHorarioEspecial("2026-12-24", "15:00", 60), true);
  assert.equal(validarHorarioEspecial("2026-12-24", "15:00", 90), false);
  // O restante do período 17–23 e os dias fechados não são reabertos.
  assert.equal(validarServicoDezembro2026("2026-12-23",
    { nome: "Pedicure Simples", categoria: "Pedicure" }).valido, false);
  assert.equal(validarDataNaJanela("2026-12-25", AGORA).valido, false);
});

test("backend de criação e reagendamento usa as mesmas restrições comerciais", async () => {
  const reservas = await readFile(new URL("../infra/backend/src/pixReservas.js", import.meta.url), "utf8");
  const isencao = await readFile(new URL("../infra/backend/src/agendamentosIsencaoPix.js", import.meta.url), "utf8");
  const admin = await readFile(new URL("../infra/backend/src/agendaBloqueios.js", import.meta.url), "utf8");
  const frontend = await readFile(new URL("../agendamento.js", import.meta.url), "utf8");
  assert.match(reservas, /validarServicoDezembro2026\(data, servico\)/);
  assert.equal((isencao.match(/validarServicoDezembro2026\(data, servico\)/g) || []).length, 2);
  assert.match(admin, /!listarSlotsGerenciaveis\(data, agora\)\.length/);
  assert.match(frontend, /const dezembroBloqueado = dataIso\.startsWith\("2026-12"\) && !AGENDA_DEZEMBRO_2026_ABERTA/);
  assert.match(frontend, /validarServicoDezembro2026\(dataIso, servicoInfo\)/);
});
