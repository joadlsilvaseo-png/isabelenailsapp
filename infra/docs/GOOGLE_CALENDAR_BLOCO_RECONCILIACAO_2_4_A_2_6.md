# Isabele Mariana Nails — Bloco 2.4–2.6: inventario e conciliacao read-only

**Escopo concluido em codigo:** levantamento paginado Google Calendar; inventario cruzado Firestore + PostgreSQL; classificacao conservadora e relatorio para revisao humana. **Nao** e a substituicao operacional do Apps Script.

**Estado em 08/11/2026:** PR em branch isolada encadeada a #50/#49/#48/#45. Nenhum codigo, migracao 024 ou rotina deste bloco foi executado na VPS. Somente a camada OAuth de leitura ja esta funcionando na API de producao.

## Entregas deste bloco

1. **Inventario remoto:** novo metodo `listarEventos({inicio,fim})` no adaptador `infra/backend/src/googleCalendarEvents.js`. Utiliza `events.list` da API Google; consulta APENAS `id`, `iCalUID`, marcadores privados, datas de inicio/fim, status e indicador de recorrencia. Nao requisita titulo, nome, email de convidados nem descricao. Suporta `nextPageToken`, `singleEvents=true` e janela de no maximo 31 dias, com teto de 10 paginas/1500 eventos. Se limite estourar, nao devolve relatorio parcial.
2. **Classificacao sem correspondencia por nome/horario:** `infra/backend/src/googleCalendarReconciliacao.js`. Confronta `calendarEventId` do Firestore, `event_id` da outbox, `google_event_id` previamente validado no PG e event `id`/`iCalUID` da API Google. Retorna `candidato_legado`, `candidato_marcador_vps`, `ambiguo`, `conflito_marcador`, `conflito_multiplos_agendamentos`, `vinculo_ausente`, `vinculo_confirmado` etc. Nenhum candidato vira vinculo confirmado automaticamente.
3. **Agregacao das fontes:** `infra/backend/src/googleCalendarInventarioReadOnly.js`. Usa somente `Firestore.get()`, `PostgreSQL.SELECT` e listagem Google; exige `GOOGLE_CALENDAR_AUDIT_ENABLED=true` e **`GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED` diferente de `true`**. Exige janela de ate 30 dias, `fim` exclusivo, falha fechada com listas incompletas e desconsidera vinculos fora do periodo para nao criar falsas ausencias.
4. **Comando MANUAL de auditoria:** `infra/backend/scripts/calendarReadOnlyReport.mjs`. Nao faz parte do startup da API, do Docker Compose ou dos workers. O resumo do relatorio nao mostra nomes, telefones, URLs de evento ou credenciais. Opcionalmente, operador pode salvar dados de vinculos/IDs em arquivo JSON privado, com criacao exclusiva e permissao 600 sob `/root/.config/isabele-google-oauth/reports`. Nao insere nem altera registros no Google, PG ou Firestore.

## Condicoes para futura execucao na VPS

**NAO executar em producao enquanto a migração 024 nao tiver sido aplicada/validada com backup e autorizacao expressa.** O comando depende de `google_calendar_event_links` e da nova imagem de API.

Checklist do operador em etapa FUTURA, nao realizado agora:

- Confirmar que todas as PRs de base foram revisadas/mergeadas e que o deploy preserva as variaveis atuais de PIX e notificacoes; verificar respaldos e rollback.
- Aplicar migração **024** em janela aprovada, confirmar tabelas sem povoamento automatico e zero impacto nos dados existentes.
- Confirmar OAuth Google `check` ainda retornando `leituraCalendar=true`, a conta correta, o `GOOGLE_CALENDAR_ID` real e a API HTTP 200.
- Habilitar temporariamente `GOOGLE_CALENDAR_AUDIT_ENABLED=true` apenas para um comando MANUAL, nunca no processo HTTP. Manter `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=false` ou ausente.
- Inspecionar um periodo curto com baixo volume, depois varios intervalos sucessivos menores que 30 dias. Exemplo futuro (onde ambiente/credenciais PG+Firebase+OAuth estiverem ja disponiveis):

```bash
node infra/backend/scripts/calendarReadOnlyReport.mjs 2026-12-01 2026-12-08
```

O exemplo acima **nao substitui a preparacao do ambiente**; o processo precisa herdar as variaveis privadas, sem publicá-las em terminal ou GitHub. Ele nao deve ser executado a partir de um diretorio/container incorreto, nem com flags de escrita ligadas.

Para exportacao excepcional dos IDs necessarios a revisao:

```bash
node infra/backend/scripts/calendarReadOnlyReport.mjs 2026-12-01 2026-12-08 --report=calendario-2026-12-01.json
```

O arquivo privado fica fora do repo. Nao copiar seu conteudo integral para ChatGPT, issues ou PR, porque mapeia reservas e eventos reais.

## Critérios para prosseguir à migração dos workers

O inventario serve para descobrir divergencias, **nao** para habilitar operacoes automaticamente. Para qualquer janela submetida a validacao operacional:

- A listagem Google precisa ser COMPLETA, com todas as paginas recuperadas.
- Eventos marcados `ambiguo`, `conflito_*`, `revisao_recorrencia`, `vinculo_ausente` e `sem_correspondencia` exigem decisao humana e, se pertinente, validacao por ID remoto. Eventos antigos podem nao ter propriedades privadas de origem.
- Confirmar que nenhum evento e reivindicado por dois agendamentos, que o status Firestore/PG corresponde ao da agenda e que eventos novos terao `extendedProperties.private.isabeleAgendamentoId`.
- Nao criar eventos para `sem_correspondencia` sem investigar o Apps Script antigo, que pode ter criado o evento sem identificador seguro.
- Nao interpretar o campo antigo `calendarEventId`/`event_id` como `events.id` sem `events.get` ou `events.list(iCalUID)`.
- Testar a futura escrita com um evento de TESTE explicitamente controlado, jamais com uma cliente de producao, e somente apos permissao expressa e plano de rollback.
- Criar **outra fase/bloco** para o cutover: vinculo persistente transacional, worker por operacao, feature flags separadas por fluxo, dual-read/dry-run, monitoramento, reconciliacao de timeouts e desligamento de Apps Script ao final. O codigo deste bloco nao faz isso.

## Limites identificados

- A janela de 30 dias precisa ser dividida para meses longos (dezembro tem 31 dias).
- A lista so inclui eventos visiveis no Calendar consultado, nao calendarios secundarios nao configurados.
- O Google pode retornar instancias recorrentes com IDs distintos de `iCalUID`; sem identidade inequivoca, elas exigem revisao manual.
- O relatorio nao classifica atividades e feriados como agendamentos sem referencias; registra quantidade de eventos sem vinculo. Nao le titulos, nomes de clientes ou descricoes.
- Consultas ocorrem de forma concorrente entre Firestore/PG/Google, portanto representam um retrato proximo, **nao transacao atomica entre os sistemas**. Para janela ativa, repetir para verificar mudanças recentes antes de autorizar migracao.
- Nenhum inventario com dados reais foi feito neste PR. Assim, **nao** sabemos ainda quantos agendamentos legados sao conciliaveis.

## Testes

`npm test` inclui:
- `googleCalendarReconciliacao.test.js`: vinculacoes, iCalUID, ambiguidades, marcadores e privacidade.
- `googleCalendarInventarioReadOnly.test.js`: paginação, limites, fontes incompletas, consultas read-only e periodos.
- Suites existentes 2.1–2.3 e jobs PG17 para migração 024 continuam sendo executados.

**IMPORTANTE:** uma migracao posterior **nao** deve marcar como 'confirmado' qualquer candidato apenas porque este relatorio sugere um unico evento.

Documentacao oficial Google: https://developers.google.com/workspace/calendar/api/v3/reference/events/list e https://developers.google.com/workspace/calendar/api/guides/pagination .
