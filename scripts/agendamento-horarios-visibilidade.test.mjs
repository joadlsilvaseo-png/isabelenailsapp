import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const ler = (nome) => readFile(new URL("../" + nome, import.meta.url), "utf8");

test("carrosséis Manhã/Tarde/Noite e setas continuam com o layout atual", async () => {
  const pagina = await ler("agendamento.js"), css = await ler("agendamento.css");
  for (const faixa of ["Manhã", "Tarde", "Noite"]) {
    assert.ok(pagina.includes('criarGrupoHorario("' + faixa + '"'));
  }
  assert.match(pagina, /agendamento-time-carousel/);
  assert.match(pagina, /agendamento-carousel-arrow/);
  assert.match(css, /scroll-snap-type:\s*x proximity/);
});

test("exibir livres por padrão e disponibilizar visualização opcional dos demais", async () => {
  const pagina = await ler("agendamento.js"), html = await ler("agendamento.html");
  assert.match(html, /id="agendamento-ver-indisponiveis"/);
  assert.match(html, /aria-controls="horarios-agendamento" hidden/);
  assert.match(html, /Mostramos primeiro apenas os horários livres/);
  assert.match(pagina, /botao\.hidden = true/);
  assert.match(pagina, /alternarIndisponiveis\.setAttribute\("aria-pressed", String\(mostrar\)\)/);
  assert.match(pagina, /slot\.hidden = !mostrar/);
  assert.match(pagina, /Sem horários disponíveis neste período/);
  assert.match(pagina, /Sem horários disponíveis nesta data para este serviço/);
});

test("validações da API, Firestore e bloqueios continuam sem exceções artificiais", async () => {
  const pagina = await ler("agendamento.js"), helper = await ler("agendamentoDisponibilidade.js");
  assert.match(pagina, /consultarIntervalosDisponibilidade/);
  assert.match(pagina, /validarHorarioEspecial\(dataIso, horarioTexto, duracaoServico\)/);
  assert.match(pagina, /intervaloSobrepoeDisponibilidade\(atual, fimServico, intervalosIndisponiveis\)/);
  assert.match(pagina, /Não foi possível carregar os horários/);
  assert.match(helper, /indisponivelComBufferSequencial\(inicio, fim, intervalos\)/);
});

test("todos os inícios novos passam na validação compartilhada sob lock", async () => {
  for (const nome of ["pixReservas.js", "agendamentosIsencaoPix.js", "pixReagendamentoPagoOperacao.js"]) {
    const src = await ler("infra/backend/src/" + nome);
    assert.match(src, /if \(!\(await verificarEncaixeNoBanco\(\{/);
    assert.doesNotMatch(src, /% 30 === 15 && !\(await verificarEncaixeNoBanco/);
  }
  const alterarServico = await ler("infra/backend/src/agendamentoAlteracaoServico.js");
  assert.match(alterarServico, /duracaoNova > snapshot\.duracaoAnterior && !\(await verificarEncaixeNoBanco/);
  const pixPago = await ler("infra/backend/src/pixConfirmacaoFirestore.js");
  assert.match(pixPago, /ignorarProtecaoInicio: true/);
});
