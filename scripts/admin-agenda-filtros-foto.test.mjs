import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = new URL("../", import.meta.url);
const [html, js, css, sw, api] = await Promise.all([
  readFile(new URL("admin-agendamentos.html", base), "utf8"),
  readFile(new URL("admin-agendamentos.js", base), "utf8"),
  readFile(new URL("admin-agendamentos.css", base), "utf8"),
  readFile(new URL("service-worker.js", base), "utf8"),
  readFile(new URL("agendamentosApi.js", base), "utf8"),
]);

test("somente o grupo técnico confirmado/reagendado aparece como Agendados na interface", () => {
  assert.doesNotMatch(html, /data-status-filter="agendados"/);
  assert.doesNotMatch(html, /data-summary-filter="agendados"/);
  assert.match(html, /data-status-filter="confirmados"[\s\S]{0,130}Agendados/);
  assert.match(html, /data-summary-filter="confirmados"[\s\S]{0,800}Agendados/);
  assert.match(js, /statusNormalizado === "confirmado"[\s\S]*?statusNormalizado === "reagendado"[\s\S]*?return "confirmados"/);
  assert.match(js, /confirmado: "Agendado"/);
  assert.match(js, /confirmado: "confirmar_admin"/);
  assert.match(js, /status: "confirmado"/);
  assert.doesNotMatch(html, /admin-total-pendentes/);
});

test("foto personalizada autenticada precede foto HTTPS, com iniciais como fallback", () => {
  assert.match(js, /function exibirAvatarClienteNoModal/);
  assert.match(js, /async function carregarFotoDoPerfilNoModal/);
  assert.match(js, /encodeURIComponent\(uid\) \+ "\/foto"/);
  assert.match(js, /getIdToken\(\)/);
  assert.match(js, /formato !== "image\/webp"/);
  assert.match(js, /avatar\.textContent = obterIniciais\(obterNomeCliente\(agendamento\)\)/);
  assert.match(js, /fotoExterna = obterFotoCliente\(agendamento\)/);
  assert.match(js, /!fotoModalAgendamentoUrl/);
  assert.match(js, /URL\.revokeObjectURL\(fotoModalAgendamentoUrl\)/);
  assert.match(js, /versao === versaoFotoModalAgendamento/);
  assert.match(js, /exibirAvatarClienteNoModal\(/);
  assert.match(css, /\.admin-modal-client \.admin-modal-client-avatar/);
  assert.match(css, /font-size: 15px/);
});

test("Alterar Serviço mantém liberação explícita e fail-closed da API", () => {
  assert.match(js, /let alterarServicoDisponivel = false/);
  assert.match(js, /alterarServicoDisponivel && \["confirmado", "reagendado"\]\.includes\(status\)/);
  assert.match(js, /if \(!alterarServicoDisponivel\) throw new Error/);

  const consultaConfiguracao = api.slice(api.indexOf("export async function consultarLiberacaoAlterarServicoApi"));
  assert.match(consultaConfiguracao, /if \(!usuario\) return false/);
  assert.match(consultaConfiguracao, /if \(!resposta\.ok\) return false/);
  assert.match(consultaConfiguracao, /catch \{\s*return false;\s*\}/);
});

test("consulta da flag ocorre em paralelo, sem renderizar a agenda antes da resposta", () => {
  const inicioCarga = js.indexOf("async function carregarAgendamentos(");
  const fimCarga = js.indexOf("\nfunction ordenarAgendamentos()", inicioCarga);
  assert.ok(inicioCarga >= 0 && fimCarga > inicioCarga);
  const carga = js.slice(inicioCarga, fimCarga);

  const inicioConsultasFirestore = carga.indexOf("await Promise.all([");
  const aguardoFlag = carga.indexOf("alterarServicoDisponivel = await aguardarLiberacaoAlterarServico");
  const primeiraRenderizacao = carga.indexOf("aplicarFiltros();");
  assert.ok(inicioConsultasFirestore >= 0);
  assert.ok(aguardoFlag > inicioConsultasFirestore);
  assert.ok(primeiraRenderizacao > aguardoFlag);

  const inicioPagina = js.slice(js.indexOf("function iniciarPagina()"));
  assert.match(inicioPagina, /const autorizado = await verificarAcessoAdmin\(user\);[\s\S]*?if \(!autorizado\)[\s\S]*?const liberacaoAlterarServico = consultarLiberacaoAlterarServicoApi\(auth\)\.then\(\(habilitado\) => \{\s*alterarServicoDisponivel = habilitado === true;\s*return alterarServicoDisponivel;\s*\}\);\s*await carregarAgendamentos\(liberacaoAlterarServico\);/);
});

test("cache PWA e JS/CSS foram atualizados", () => {
  assert.match(html, /admin-agendamentos\.js\?v=1\.0\.3/);
  assert.match(html, /admin-agendamentos\.css\?v=1\.0\.5/);
  assert.match(sw, /CACHE_VERSION = "v\d+"/);
  assert.match(sw, /\.\/admin-agendamentos\.js/);
  assert.match(sw, /\.\/admin-agendamentos\.css/);
});
