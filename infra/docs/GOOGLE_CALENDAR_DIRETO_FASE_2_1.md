# Google Calendar direto na VPS — Fase 2.1: adaptador isolado

**Estado:** somente codigo e testes em branch, sem deploy, sem rotas novas, sem processamento de fila. `Apps Script` permanece responsavel por eventos em producao.

## O que foi criado

`infra/backend/src/googleCalendarEvents.js` exporta:

- `gerarIdEventoGoogle(agendamentoId)`: ID deterministico (`imn` + SHA-256 em hexadecimal), compativel com as restricoes da API Google.
- `criarAdaptadorGoogleCalendar({ calendarId, obterAccessToken, fetcher, env })`: recebe credencial de acesso via callback *ainda nao conectado* ao banco.
- `consultarEvento({ eventId })`: chamada `events.get` apenas para leitura.
- `criarEvento(dados)`: `events.insert` com ID deterministico e propriedade privada de vinculacao.
- `atualizarEvento(dados)`: `events.get`, validacao do marcador e `events.patch` com cabecalho `If-Match`/ETag.
- `excluirEvento({ agendamentoId, eventId })`: `events.get` e `events.delete` com `If-Match`.

Campos exigidos na criacao/atualizacao: `agendamentoId`, `nomeCliente`, `servico`, `inicio` e `fim`. Datas devem ser ISO 8601 **com fuso ou offset explicito**. A interface ainda nao converte os horarios locais do Firestore/PostgreSQL para esse formato.

## Protecao obrigatoria

**Duas flags independentes** para operacoes de escrita:

```dotenv
GOOGLE_CALENDAR_OAUTH_ENABLED=true
GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=false
```

O adaptador valida `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=true` e OAuth ativo **antes de consultar token ou API**. Esta flag **nao foi incluida no Compose de producao**: por omissao permanece desativada.

**NAO definir `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=true` na VPS nesta fase.** Nao adicionar endpoints, jobs ou chamadas ao novo adaptador ate reconciliar eventos e implementar persistencia de vinculacao.

## Idempotencia e seguranca

1. Criacoes usam sempre o **mesmo ID Google** para o mesmo `agendamentoId`; nenhuma repeticao automatica de POST em erro de timeout.
2. Se ocorrer `409`, consultar `events.get` pelo mesmo ID e validar `extendedProperties.private.isabeleAgendamentoId` e `isabeleOrigem`. Caso divergente, falhar sem alterar.
3. `patch` e `delete` exigem marcador `isabele-vps` e o ID de agendamento correspondente. **Eventos antigos do Apps Script sem esse marcador nao devem ser modificados** pelo novo adaptador.
4. Alteracoes usam `If-Match` com `etag` da leitura; `412` interrompe a operacao, sem sobreposicao silenciosa.
5. Cancelamento com `GET 404` indica que o ID solicitado nao foi localizado; retorna estado `jaAusente` para conciliacao, sem nova escrita.
6. O metodo `insert` recebe `sendUpdates=none` para nao enviar emails a convidados por engano.
7. O retorno de criacao so pode ser considerado confirmado se o Google devolver o ID esperado e marcador correto. **Ainda sera necessario persistir o ID real e estado numa fila duravel no banco (proxima fase).**

**Limite conhecido:** a API Google pode nao detectar toda colisao de ID devido a armazenamento distribuido. E preciso vinculo duravel no Postgres, identificacao no evento e reconciliacao antes de habilitar qualquer escrita.

**Outro limite:** `eventId` do Apps Script/Outbox nao corresponde necessariamente ao `id` exigido por `events.get`; `iCalUID` tambem e diferente do ID interno do evento. Nao reutilizar nem converter automaticamente IDs legados.

## Proximas fases (ainda nao implementadas)

- **2.2:** disponibilizar um fornecedor de access token derivado do refresh token AES-256-GCM ja salvo, confirmando novamente conta e calendario; nao expor ao frontend.
- **2.3:** criar migracao aditiva para registro persistente de `google_event_id`, vinculo ao agendamento, estado de sync, claims e recuperacao segura apos timeouts.
- **2.4:** levantar e reconciliar eventos atuais com Firestore, PG, Apps Script e Google Calendar, com revisao de ambiguidade; evitar duplicatas.
- **2.5:** migrar fluxos de criacao PIX pago/isento, reagendamento e cancelamento gradualmente com flags por caminho, testes de integracao e rollback.
- Desligar Apps Script somente depois de todas as rotas, workers e assincronismos validados.

## Validacao

`node test/googleCalendarEvents.test.js` exercita 13 casos com HTTP simulado. `npm test` incorpora a suite no CI.

**Nao testa escrita real, nao chama a conta Google da profissional e nao modifica a base de dados.**

Referencias oficiais:
- https://developers.google.com/workspace/calendar/api/v3/reference/events
- https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- https://developers.google.com/workspace/calendar/api/guides/version-resources
