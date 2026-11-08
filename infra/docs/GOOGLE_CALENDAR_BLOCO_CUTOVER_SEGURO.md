# Bloco maior — Transicao operacional controlada do Google Calendar

**Data:** 08/11/2026  
**Status:** apenas GitHub, testes isolados; NAO executado na VPS.  
**Base:** PR #51 (conciliação read-only) → #50 (migração 024) → #49 (OAuth refresh) → #48 (Events API) → #45 (OAuth já habilitado em produção por imagem isolada).

## O que foi concluído em codigo nesta entrega

### 1. Politica anti-escrita dupla, por fluxo

`infra/backend/src/googleCalendarCutoverPolicy.js` é um planejador **sem efeitos colaterais**:

- Flag principal `GOOGLE_CALENDAR_CUTOVER_ENABLED`, mais `GOOGLE_CALENDAR_OAUTH_ENABLED` e `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED`.
- Flags independentes `GOOGLE_CALENDAR_CUTOVER_CRIAR_ENABLED`, `GOOGLE_CALENDAR_CUTOVER_REAGENDAR_ENABLED`, `GOOGLE_CALENDAR_CUTOVER_CANCELAR_ENABLED`, `GOOGLE_CALENDAR_CUTOVER_ALTERAR_SERVICO_ENABLED`.
- **Todas essas flags novas permanecem AUSENTES (equivalentes a false)** em produção. Não foram incluídas no Compose nem há integração automática do planejador aos workers.
- Com flags desligadas, eventos **legados** permanecem no Apps Script como hoje.
- Se um evento já tiver vínculo `origem=vps`, desligar as flags **não permite** enviá-lo ao Apps Script. O resultado é `bloqueado`, não fallback automático.
- Com flags ligadas, reagendar/cancelar/alterar_servico só elegem vínculo VPS ativo, no calendário certo e com `estadoConciliacao=vinculo_confirmado`. Eventos antigos `legado_validado` continuam exigindo uma estratégia explícita.
- `criar` só fica elegível se o backend comprovar que é **agendamento novo após cutover**, não existe outbox antiga, não há vínculo e a conciliação confirmou ausência de evento. **Essas evidências NÃO podem vir do frontend.**
- Operação incerta, concorrente ou com evidência conflitante = **bloqueio**, nunca rota alternativa.

### 2. Migração 025: posse de lease durável

`infra/migrations/025_google_calendar_operation_lease.sql` acrescenta à **nova tabela 024** a coluna `lease_token UUID` e uma constraint para impedir estado `processando` sem token. Reaplicação é idempotente. Não mexe em tabela financeira, agendamento, PIX ou credencial OAuth.

É um arquivo de migração novo; **não aplicar na VPS antes de executar 024** e revisar o procedimento completo de backup/rollback.

### 3. Repositório transacional desacoplado

`infra/backend/src/googleCalendarCutoverStore.js`:

- `prepararIntencao` — valida as flags e dados, verifica idempotência pelo par chave + fingerprint + agendamento + tipo + evento, consulta vínculo confirmado e a outbox antiga; grava a intenção nova via transação PostgreSQL, sem chamar o Google.
- `reivindicarProxima` — reserva uma intenção `pendente` via `FOR UPDATE SKIP LOCKED` e lease UUID + prazo, somente para tipos habilitados.
- `registrarResultadoIncerto` — diante de timeout da API, salva `aguardando_confirmacao` e **nunca retorna a `pendente`**.
- `bloquearLeasesExpirados` — converte leases vencidos em `aguardando_confirmacao`, sem retry automatico.
- `confirmarCriacao` — após receber um evento efetivamente confirmado pelo Google, valida `events.id` determinístico, marcador privado `isabeleOrigem=isabele-vps` e `isabeleAgendamentoId`. Na **MESMA transação**, grava vínculo `origem=vps` e conclui a intenção. Se a transação falhar, não confirma localmente.
- Sem timers, importação em `server.js`, endpoints, agendamentos, callbacks ou worker. **Nenhuma chamada real à API Google neste bloco.**

**Limites:** as rotinas de conclusão de reagendamento, cancelamento e alteração de serviço, assim como payloads imutáveis, conferência de versões Firestore e validação de conflitos de horário no cutover, **ainda não estão integradas**. O método de confirmação atual cobre somente a criação nova; para as demais operações haverá implementação separada antes de ligar flags. Não há replay automático de operações com resposta incerta.

### 4. Preflight operacional SOMENTE LEITURA

`infra/backend/scripts/calendarCutoverPreflight.mjs`:

- Desligado por padrão, exige `GOOGLE_CALENDAR_PREFLIGHT_ENABLED=true` e escrita direta desligada.
- Usa `BEGIN TRANSACTION READ ONLY`; apenas `SELECT` de metadados e contagem por estado, sem nome de cliente, tokens, valor PIX ou IDs individuais.
- Verifica presença das migrações 023/024/025; backlog do Apps Script; estados de sincronização e candidatos à revisão.
- Retorna `autorizadoParaMigrar=false` **mesmo se não houver bloqueios SQL**: inventário Google/Firestore e revisão humana continuam obrigatórios.
- Comando manual futuro (somente após autorização e configuração correta): `node infra/backend/scripts/calendarCutoverPreflight.mjs`. Não executado aqui.

### 5. Testes automatizados

- `googleCalendarCutoverPolicy.test.js`: decisões por fluxo, rollback de flag sem fallback para Apps Script, eventos de origem VPS versus legado, criação nova e ambiguidade.
- `googleCalendarCutoverPreflight.test.js`: agregações sem PII, apenas SELECT, falha fechada e nunca aprovação automática.
- `assert_google_calendar_lease_025_pg17.sql`: checks de lease, timeout e conflito; transação revertida.
- `googleCalendarCutoverPostgres.integration.js`: PostgreSQL 17 real **efêmero no GitHub Actions**: idempotência, intent concorrente, claim, timeout, lease expirado, link atômico com resposta Google fictícia e rejeição de outbox legada.
- `.github/workflows/validar-backend.yml`: job migracoes 023/024/025 e suite de integração, além de preservar todos os jobs existentes de PIX, banco e frontend.

**O teste integra PostgreSQL real apenas de CI, mas usa evento Google simulado. Nenhum teste é executado com a agenda real da Isabele.**

## Quadro de dependências que ainda impedem o corte na produção

1. **Inventário com dados reais** e identificação de todas as origens: não executado, pois a VPS utiliza imagem anterior e ainda não possui a migração 024/025.
2. **Conciliação humana dos legados**: pendente; antigos `event_id` podem ser `iCalUID`, não `events.id`. Consultar Google e confirmar o ID remoto, inclusive casos recorrentes.
3. **Revisão do Apps Script original e seus caminhos ativos**: o worker PIX, cancelamento, reagendamento PIX pago e alteração de serviço ainda usam Apps Script. Também é necessário mapear chamadas diretas no frontend sem PIX e alterações feitas manualmente no Google Calendar.
4. **Payload durável e versões**: definir snapshots imutáveis, sincronização Firestore/PG, validação de horário e recuperação segura para reagendamento, cancelamento e troca de serviço.
5. **Deploy controlado das PRs encadeadas**: backup novo, preflight de variáveis, verificar commits locais da VPS que não devem ser sobrescritos, migrações aditivas 024 e 025 e rollback de imagem sem restaurar dump antigo sobre dados financeiros novos.
6. **Teste isolado de escrita real**: somente evento controlado de teste, com autorização específica. Testar criação, update, DELETE, status e reconciliador, antes de permitir qualquer operação da agenda de clientes.
7. **Roteamento por fluxo e observabilidade**: ativar uma flag por vez, preservar rota antiga para legados, bloquear operação incerta, comprovar nenhum envio duplo e só então desligar Apps Script.

**Critério de liberação para escrita:** somente após os sete pontos verificados. Nem a aprovação do CI nem a conexão OAuth são autorização para começar a gravar na agenda real.

## Situação operacional agora

| Item | Estado |
|---|---|
| OAuth conectado à VPS | Sim, já confirmado pelo usuário |
| Apps Script | Continua ativo |
| Migração 024/025 na VPS | **Não aplicada** |
| Cutover em produção | **Não ativado** |
| Consulta aos eventos reais | **Não realizada nesta entrega** |
| PR da transição | Ainda sem merge na main |
