# Google Calendar direto — Fase 2.3: vinculos, estado de sync e conciliacao

**Data:** 08/11/2026  
**Status:** somente GitHub, sem deploy/migracao na VPS e sem mudancas nos agendamentos.  
**Dependencias:** OAuth (PR #45), adaptador de eventos (PR #48) e renovacao de token (PR #49), ainda encadeadas e nao mergeadas na `main`.

## Objetivo da fase

Preparar uma camada persistente no PostgreSQL 17 para identificar corretamente o evento remoto de cada agendamento, manter trilhas de sincronizacao idempotentes e registrar hipoteses sobre os eventos historicos do Apps Script.

**Nao importar/agrupar automaticamente eventos legados, nao ativar escrita e nao iniciar workers nesta fase.** A migracao cria **tres tabelas vazias** e indices de seguranca sem `ALTER`, `UPDATE`, `DELETE` ou `INSERT` em tabelas existentes.

Migração: `infra/migrations/024_google_calendar_event_links.sql`.

## 1. `google_calendar_event_links` — somente vinculos confirmados

Chave primaria: `agendamento_id` (ID do agendamento no Firestore/fluxos atuais). Restricao `UNIQUE(calendar_id, google_event_id)` garante que um unico evento Google em um calendario nao seja vinculado a duas reservas diferentes.

Campos centrais:

- `agendamento_id`, `calendar_id`, `google_event_id`: identidade do vinculo.
- `origem`: `vps` ou `legado_validado` — nunca atribuir `vps` a evento historico.
- `metodo_verificacao`: `google_api` ou `revisao_manual_confirmada`; eventos novos exigem `google_api`.
- `verificado_em`, `verificado_por`: auditoria de quem confirmou o vinculo.
- `situacao`: `ativo` ou `cancelado`. Preservar o vinculo mesmo apos cancelamento permite auditoria e reduz risco de recriacao.

**Regra:** so inserir apos confirmar `events.id` pela API Google e demonstrar a correspondencia ao `agendamento_id`. Nomes/horarios iguais nao sao prova suficiente. Em eventos da VPS, exigir `extendedProperties.private.isabeleAgendamentoId` e `isabeleOrigem`. Eventos anteriores do Apps Script nao possuem necessariamente os marcadores; nao autorizar alteracoes usando o adaptador da Fase 2.1 sem estrategia explicita de legado.

**Nao confundir:** `pix_calendar_outbox.event_id`, `agendamento_cancelamentos.calendar_event_id`, `pix_reagendamentos_pagos.calendar_event_id` e `iCalUID` podem conter IDs que **nao sao** `events.id` do Google Calendar. Nada sera copiado dessas colunas para os vinculos confirmados por esta migracao.

## 2. `google_calendar_sync_operations` — intencoes imutaveis e reexecucao controlada

Tabela preparada para futura fila duravel (NAO possui worker nesta fase). Chave primaria UUID `operation_id`, campo `chave_idempotencia` com unicidade global e `fingerprint_pedido` SHA-256 para comparar a intencao com a mesma chave durante uma futura implementacao de API.

Tipos: `criar`, `reagendar`, `cancelar`, `alterar_servico`.

Estados:

| Estado | Significado |
|---|---|
| `pendente` | Nao enviado ao Google |
| `processando` | Futuro worker com lease |
| `aguardando_confirmacao` | Escrita enviada, resposta incerta; verificar remotamente antes de repetir |
| `conflito` | Divergencia ou possivel duplicacao; requer reconciliacao |
| `concluida` | Google confirmou; exige `concluido_em` |
| `falha_permanente` | Nao repetir sem nova decisao |
| `dispensada` | Operacao desnecessaria, encerrada |

O indice unico parcial `ux_google_calendar_operacao_ativa` impede **duas operacoes simultaneamente ativas/indefinidas para o mesmo agendamento**, mesmo que tenham chaves diferentes. O estado `aguardando_confirmacao` **continua bloqueante**. Isso impede que um timeout seja interpretado como permissao para criar outro evento.

Cancelamento, reagendamento e alteracao de servico exigem `google_event_id` conhecido. Uma operacao encerrada nao e executada automaticamente. Metadados de tentativa, lease, prazo, codigo de erro sem informacoes pessoais e tempos de conclusao permitem implementar o worker em outra fase.

**Importante:** unicidade e constraints do PostgreSQL sao garantias estruturais, mas o futuro worker deve usar transacoes/`SELECT ... FOR UPDATE SKIP LOCKED`, conferir estado de callback e gravação do vinculo e assegurar que a intencao e seu fingerprint sao identicos em retries. Sem isso, a fila nao esta pronta para operar.

## 3. `google_calendar_reconciliation_candidates` — hipoteses sem efeito na agenda

Tabela de candidatos a vinculo historico, NAO de vinculos confirmados. Pode haver dois ou mais candidatos para a mesma reserva; isso e intencional.

- `google_event_id`: **somente** o ID retornado pela API Google (quando conhecido).
- `legacy_event_id`: evidencia antiga opcional, que pode conter `@google.com`.
- `fonte`: `pix_outbox`, `firestore`, `google_calendar` ou `revisao_manual`.
- `fingerprint_evidencia`: opcional, SHA-256 da evidencia normalizada, sem guardar o nome da cliente no PostgreSQL.
- `situacao`: `pendente`, `revisao_manual`, `conflito`, `validado`, `rejeitado`.
- `revisor_uid`, `revisado_em`: obrigatorios para validar/rejeitar.

Validar um candidato **nao cria automaticamente** registro em `google_calendar_event_links`: o reconciliador futuro deve confirmar conflitos entre candidatos e a correspondencia remota, numa etapa transacional separada e auditada.

## Sequencia planejada sem riscos

1. **Agora:** codigo SQL + validacoes SQL PostgreSQL 17 isolado no GitHub; nao tocar na VPS.
2. **Fase 2.4:** inventario somente leitura das fontes reais (Firestore, PostgreSQL, Google Calendar), classificacao de ambiguidades e revisao manual; nunca alterar eventos em massa.
3. **Depois da conciliacao:** validacao da tabela de vinculos, rotina transacional de registro e recuperacao, testes com API Google sem efeitos colaterais, avaliacao de deploy da migracao.
4. **Somente apos autorizacao e validacao operacional:** habilitar por flags independentes escrita do novo worker, por fluxo (PIX pago, isento, reagendamento, alteracao de servico, cancelamento), com retorno ao Apps Script disponivel.
5. **Encerramento:** remover o Apps Script apenas quando nenhum fluxo antigo continuar dependente dele.

## Validacao CI

Workflow: `.github/workflows/validar-backend.yml`, job **`validar-migracao-024-google-calendar`**. Sobe PostgreSQL **17-alpine** temporario, aplica migracoes 023 + 024 e reaplica 024 para comprovar idempotencia do esquema.

Executa `infra/backend/test/sql/assert_google_calendar_links_pg17.sql`, que verifica:

- Estruturas vazias após migração; sem populate/backfill automatico.
- Unicidade: um evento remoto nao pode pertencer a dois agendamentos e um agendamento nao pode ter dois eventos confirmados.
- IDs com `@google.com` nao podem ser usados como `events.id` confirmado; podem ser guardados como legado candidato.
- Operacoes com timeout ainda bloqueiam novas escritas; apos conclusao corretamente registrada, uma nova intencao e permitida.
- Chave idempotente global; `cancelar` sem ID remoto e `concluida` sem timestamp sao rejeitados.
- Multiplos candidatos por reserva continuam visiveis; validacao exige revisor e nao cria automaticamente vinculo confirmado.
- Toda a massa de teste sofre `ROLLBACK`; as tabelas continuam vazias.

O job confirma que as tabelas financeiras legadas nem existem no banco temporario. Isso comprova que a migracao **nao depende** das tabelas de agendamento/PIX — nao prova compatibilidade total com os dados reais da VPS. Fazer backup, preflight e revisao antes de qualquer aplicacao futura na producao.

## Estado de deploy

- `GOOGLE_CALENDAR_OAUTH_ENABLED=true` continua ativo na VPS para leitura OAuth.
- `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED` continua **ausente/desligado**.
- Nenhuma nova tabela foi criada em producao nesta fase.
- O Apps Script continua recebendo as operacoes de Calendar.
