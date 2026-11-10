# Google Calendar — bloco operacional: persistencia e protecao do cutover

**Projeto:** Isabele Mariana Nails — 08/11/2026  
**Entrega:** infraestrutura de estado duravel no GitHub, NAO cutover em producao.

## Escopo implementado no bloco

1. **Registro de intencoes** (`src/googleCalendarSafeStore.js`): `registrarIntencaoCalendar` cria somente uma operacao em `google_calendar_sync_operations` (migracao 024), em transacao Postgres. Usar `chaveIdempotencia` igual em repeticoes do mesmo pedido; o fingerprint SHA-256 impede que uma chave seja reaproveitada para outro payload. Advisory lock por agendamento serializa decisoes em diferentes containers.
2. **Vinculo e recuperacao**: `confirmarIntencaoCalendar` grava o `google_calendar_event_links` e encerra a operacao na mesma transacao, exigindo evidencias do evento Google esperado e marcadores `isabele-vps` nos eventos de criacao/atualizacao. Eventos historicos do Apps Script com `origem=legado_validado` NAO podem ser atualizados pelo adaptador direto.
3. **Reivindicacao exclusiva**: `reivindicarIntencaoCalendar` usa `FOR UPDATE SKIP LOCKED` e `lease_token` UUID para impedir que processos diferentes assumam a mesma operacao. O timeout e o lease vencido **nao** ativam reenvio automatico. `suspenderIntencaoIncerta` marca `aguardando_confirmacao` apenas com fencing token correspondente.
4. **Permissao expressa para criar eventos**: migracao 026 cria `google_calendar_creation_authorizations`. Toda reserva nova precisa possuir uma autorizacao nao consumida `nova_reserva_verificada` com evidencia SHA-256 e responsavel. A autorizacao e consumida na MESMA transacao do registro da intencao. Nao existe rotina que popule isso automaticamente; ausencia de evento conhecido **nao** e prova de reserva nova.
5. **Inventario read-only mais preciso**: `googleCalendarInventarioReadOnly.js` busca somente vinculos relativos aos IDs identificados na janela consultada, sem truncar consultas por uma contagem global de historico fora do periodo.

## Migracoes

- `024_google_calendar_event_links.sql` — tres tabelas para vinculos, operacoes e candidatos legados (preparada anteriormente, ainda sem deploy).
- `025_google_calendar_lease_fencing.sql` — coluna `lease_token`, CHECK de estado e indice. Idempotente.
- `026_google_calendar_creation_authorizations.sql` — autorizacao explicita de reserva nova, nao populada. Idempotente.

**Nenhuma dessas migracoes foi aplicada na VPS durante este bloco.** Nao realizar `psql -f` em producao sem preflight, snapshot atualizado e revisao de efeitos.

## Flags independentes (TODAS ausentes/desabilitadas em producao)

```dotenv
GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED=false
GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED=false
GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=false
```

A VPS ja possui `GOOGLE_CALENDAR_OAUTH_ENABLED=true` para autenticacao/consulta. Isso NAO libera escrita direta. Registrar intencao exige QUEUE=true; reivindicar/confirmar/suspender tambem exigem WORKER=true e DIRECT_WRITE=true.

O adaptador `googleCalendarSafeStore.js` nao e importado por `server.js`, nao possui rotas, nao inicializa worker, nem escreve no Google Calendar. Os workers do Apps Script continuam inalterados.

## Validacao no CI

Workflow `Validar backend Isabele Nails`: aplica 023, 024 (duas vezes), 025 (duas vezes) e 026 (duas vezes) em PostgreSQL 17 temporario. Executa `node --test test/googleCalendarSafeStore.postgres.test.js` com fixture ficticia e verifica:

- Nenhuma gravacao sem flag e nenhuma criacao sem autorizacao da reserva nova.
- Unicidade/idempotencia de operacao e correspondencia de fingerprints.
- Consumo unico da autorizacao dentro da transacao.
- Reivindicacao exclusiva sob lease, rejeicao de worker com lease obsoleto.
- Timeout que permanece bloqueante ate confirmar o evento certo.
- Vinculo criado atomicamente e confirmacao repetida idempotente.
- Reagendamento sem marcador privado bloqueado.
- Cancelamento sem confirmacao bloqueado e cancelamento com evidencia confirmado.
- Eventos legados e candidatos nao conciliados NAO recebem escrita pelo adaptador.

Banco CI eh descartavel; nenhuma cliente real, PIX ou agenda externa e alterado.

## O que ainda impede a substituicao definitiva do Apps Script

**Nao publicar a flag em producao nem desativar Apps Script apenas porque o CI passou.** Antes faltam:

1. Fazer inventario REAL read-only dos calendarios/agendamentos com o OAuth ja autorizado, apos aplicar migração 024 de forma controlada.
2. Revisar relatorio de correspondencias legadas. Nao importar `iCalUID` como `events.id` sem validar. Resolver ambiguidades e recorrencias manualmente. Os eventos legados nao possuem necessariamente os marcadores da VPS.
3. Criar autorizacao `nova_reserva_verificada` no fluxo futuro real com prova de que o agendamento nasceu APOS corte controlado, sem evento anterior.
4. Criar um worker exclusivo que reconstitua payload atualizado no Firestore/PG com lock e compare versoes, chama a API Google e fornece `googleEvent` validado + `leaseToken` ao store. **Esse worker NAO foi criado nesta PR**. Sem ele, nenhuma chamada remota ocorre a partir do store.
5. Integrar separadamente os fluxos: criacao PIX pago/isento, reagendamento PIX pago, reagendamento profissional/cliente, alterar servico, cancelamento e agendamentos sem PIX, conferindo as distintas URLs de Apps Script. Nada disso foi substituido neste bloco.
6. Fazer canario com teste isolado autorizado e sem clientes reais, monitorar logs e divergencias PG/Firestore/Calendar e ter rollback do Docker pronto.
7. Desativar Apps Script somente quando a cobertura dos fluxos estiver 100% comprovada. Nao gerar dois eventos (dual-write) para o mesmo agendamento.

## Estado das PRs encadeadas

`#45` OAuth → `#48` Events API → `#49` Token Provider → `#50` PG links → `#51` inventario → **PR deste bloco**.

Por enquanto, PRs abertas e empilhadas. A API OAuth existente ja foi colocada na VPS por imagem isolada; isso NAO significa que todas as fontes foram mergeadas na `main` ou estao em producao.

### Regra de seguranca

**Nao fazer restore de backup inteiro do PostgreSQL em producao** se houver novas cobrancas/agendamentos apos o backup. Reversao da API deve preservar dados financeiros atuais.
