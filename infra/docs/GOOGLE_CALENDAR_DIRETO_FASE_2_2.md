# Google Calendar direto na VPS — Fase 2.2: fornecedor seguro de tokens

**Data:** 08/11/2026  
**Status:** desenvolvimento isolado no GitHub, sem deploy e sem alteracao dos fluxos de producao.

## Objetivo

Conectar o adaptador `googleCalendarEvents.js` (Fase 2.1) a uma fonte real de access tokens: o **refresh token criptografado** que ja foi autorizado pela conta da Isabele e persistido no PostgreSQL pela Fase OAuth.

Este documento nao autoriza ativacao de escrita ou migracao de agendamentos.

## Implementacao

Modulo novo: `infra/backend/src/googleCalendarTokenProvider.js`

Funcao exportada:

```javascript
import { criarAdaptadorGoogleCalendarComOAuth } from "./googleCalendarTokenProvider.js";

// Exemplo do backend em futuro fluxo autenticado; NAO chamar em producao nesta fase.
const calendar = criarAdaptadorGoogleCalendarComOAuth(pool, { env: process.env });
const evento = await calendar.consultarEvento({ eventId: "ID_REAL_VALIDADO" });
```

Essa funcao entrega **somente o adaptador** com as operacoes existentes: `consultarEvento`, `criarEvento`, `atualizarEvento`, `excluirEvento`. Nao exporta o access token, refresh token nem a funcao interna que renova credenciais.

O modulo nao e importado em `server.js`, nao cria rotas, nao agenda tarefas, nao chama o Google na importacao e nao foi integrado ao worker de PIX.

### Operacao quando o adaptador for usado futuramente

1. Verifica `GOOGLE_CALENDAR_OAUTH_ENABLED=true` por meio da configuracao existente de OAuth.
2. Busca exclusivamente `connection_name = 'isabele'` em `public.google_calendar_oauth_credentials`.
3. Compara `google_email` com `GOOGLE_CALENDAR_EXPECTED_EMAIL` e decifra o refresh token com a chave AES-256-GCM existente.
4. Solicita novo access token via `POST https://oauth2.googleapis.com/token` usando o `grant_type=refresh_token` e credenciais privadas do backend.
5. Valida a resposta, o e-mail verificado no endpoint Google UserInfo e o acesso ao `GOOGLE_CALENDAR_ID` via `events.list` com `fields=kind`, `maxResults=1`.
6. Retorna o access token somente ao adaptador interno, permitindo executar a consulta de evento. O token **nao e enviado ao browser**.
7. Se o Google fornecer um novo refresh token na renovacao, armazena SOMENTE a versao cifrada com `UPDATE ... WHERE ... refresh_token_encrypted = versao_anterior RETURNING` (compare-and-swap). Se a credencial mudar durante a renovacao, rejeita o resultado e **nao sobrescreve** a reconexao recente.
8. Se nao houver rotacao, confere novamente a versao persistida no banco. Nao grava nada no PostgreSQL durante renovacoes normais sem rotacao.

### Protecoes

- A atualizacao do refresh token so acontece depois de validar e-mail e calendario. Falhas fecham a operacao.
- Erros HTTP e de rede sao genericos; nao extraem respostas que podem conter credenciais nem imprimem corpo/segredos em logs.
- Cache do access token **apenas em memoria**, por ate cinco minutos e nunca alem de 60 segundos antes da expiracao informada pelo Google.
- Renovacoes concorrentes na mesma instancia compartilham uma operacao (singleflight) para reduzir corrida de refresh.
- Uma desativacao de OAuth interrompe o acesso mesmo quando ha um token em cache.
- A verificacao da agenda **nao le dados de clientes**, limitando a resposta a `kind`.
- A ausencia de conexão, conta incorreta, chave invalida, `invalid_grant`, falha Google ou conflito de credencial impedem uso do adaptador.
- **A escrita continua BLOQUEADA por default**: `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED` ausente ou diferente de `true`. `GOOGLE_CALENDAR_OAUTH_ENABLED=true` sozinho nao libera nenhum `insert`, `patch` ou `delete`.
- A funcionalidade **nao esta implantada** e o `Apps Script` continua responsavel pela agenda.

### Observacoes e riscos para etapas futuras

- O refresh token de producao nao foi usado nos testes; todos usam valores ficticios e HTTP/PG simulados.
- Cache em processo e locks locais nao substituem coordenacao entre containers. Persistencia de vinculos, fila duravel e reconciliação de eventos antigos devem anteceder a ativacao de qualquer escrita.
- Token em cache pode sofrer revogacao antes de expirar. A API Google pode responder HTTP 401; futuramente sera necessario tratar invalidacao e repeticao controlada de leituras, mas **nunca repetir uma escrita incerta de forma automatica**.
- O OAuth ja esta autorizado na VPS, mas sua implementacao no GitHub permanece em PR separada (#45); o novo modulo depende das Fases 1 e 2.1 e nao deve ser mergeado isoladamente na `main`.
- Nao alterar a configuracao privada `/root/.config/isabele-google-oauth/` ou executar deploy nesta etapa.

## Validacao

`node test/googleCalendarTokenProvider.test.js` cobre **16 casos**, incluindo ausencia de credencial, email divergente, falha na chave, refresh, cache, simultaneidade, rotacao segura, CAS, alteracao concorrente, acesso negado ao calendario e bloqueio de escrita.

`npm test` inclui essa nova suite no CI existente. Sem chamadas reais ao Google ou PostgreSQL.

## Proxima fase — 2.3

Criar modelo persistente para vincular `agendamentoId` / `googleEventId`, controlar status de sincronizacao e conciliar a heranca dos eventos antigos. So depois planejar testes e migracao gradual do worker de PIX e demais operacoes. A escrita direta deve continuar desligada.

Referencias: [OAuth web server/offline access](https://developers.google.com/identity/protocols/oauth2/web-server) e [Calendar Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
