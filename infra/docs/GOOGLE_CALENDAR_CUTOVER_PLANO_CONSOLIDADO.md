# Plano de cutover consolidado — Apps Script para Google Calendar Events API

Data: 08/11/2026. **Status: implementado em GitHub, NÃO ativado em produção.**

PR de integração: **#56**, empilhada sobre **#55** (OAuth, adaptador,
vínculos, migrações 024–026, conciliação, fila e auditoria).

## O que está integrado no código

| Fluxo | Fonte antiga | Fonte direta com flag | Proteção |
|---|---|---|---|
| PIX pago e isento — criar | `pixCalendarWorker.js` → GAS | `googleCalendarDirectBridge.criarPix` | autorização única por booking novo e ID determinístico |
| Cancelar | `pixCalendarWorker.js` → GAS | `googleCalendarDirectBridge.cancelar` | vínculo aprovado, ETag, DELETE idempotente |
| PIX pago — reagendar | `pixReagendamentoPagoOperacao.js` → GAS | `googleCalendarDirectBridge.reagendarPago` | saga original + operação durável da ponte |
| Alteração de serviço | `agendamentoAlteracaoServico.js` → GAS | `googleCalendarDirectBridge.alterarServico` | bloqueio por operação, ETag e revisão de ownership |
| Reagendamento sem PIX | frontend → GAS `no-cors` | backend `reagendarComBloqueio` → `googleCalendarDirectBridge.reagendarIsento` | retorna `calendarDiretoHabilitado` para suprimir segundo POST |

As flags individuais mantêm o **GAS como padrão**. Com uma flag direta
ativada, **não há fallback automático para GAS** após erro; isso evita eventos
duplicados. Os scripts antigos e os pagamentos não foram removidos.

## Estado conhecido na VPS

- API HTTP 200 na imagem de OAuth stage `isabele-nails-api:oauth-stage-529a91d3`.
- OAuth da conta da profissional configurado e testado.
- Migrações **024, 025 e 026** aplicadas; tabelas inicialmente vazias.
- Backup pré-migração verificado: 304 KB, manifesto 136 entradas.
- 2026-11-01 a 2026-12-30: **114 marcadores legados únicos** identificados
  no Google, **111 candidatos fortes**, 14 registros com cancelamento
  concluído e 3 divergências separadas (14/11 09:00, 10/12 11:00,
  21/12 07:00). **A contagem final para importação só pode ser conhecida
  após executar a prévia atual com critérios completos e estados atualizados.**
- Nenhum vínculo legado foi importado na ocasião do diagnóstico.

## Travas que precisam estar DESLIGADAS no deploy inicial

```dotenv
GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=false
GOOGLE_CALENDAR_CUTOVER_QUEUE_ENABLED=false
GOOGLE_CALENDAR_CUTOVER_WORKER_ENABLED=false
GOOGLE_CALENDAR_DIRECT_CRIAR_PIX_ENABLED=false
GOOGLE_CALENDAR_DIRECT_CANCELAR_ENABLED=false
GOOGLE_CALENDAR_DIRECT_REAGENDAR_PAGO_ENABLED=false
GOOGLE_CALENDAR_DIRECT_REAGENDAR_ISENTO_ENABLED=false
GOOGLE_CALENDAR_DIRECT_ALTERAR_SERVICO_ENABLED=false
GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED=false
GOOGLE_CALENDAR_AUDIT_ENABLED=false
```

Manter `GOOGLE_CALENDAR_OAUTH_ENABLED=true` e a chave AES existente para
não perder a credencial. **Não substituir** o container ou a configuração
produtiva sem comparar o Compose/env reais e testar o rollback.

## Importação legada em DUAS etapas (revisão e escrita PG explícita)

O código da prévia está em:

`infra/backend/scripts/calendarLegacyReview.mjs`

Ele funciona em runtime com os novos arquivos, OAuth/Firestore e PostgreSQL.
Ao usar `GOOGLE_CALENDAR_AUDIT_ENABLED=true`, lê as três fontes e retorna
apenas resumo agregado, hash SHA-256 e exceções por tipo. Não transmite dados
de clientes ao terminal. **Não precisa repetir outras auditorias antigas.**

Os intervalos nunca devem superar 30 dias, com fim EXCLUSIVO:

- Novembro: `2026-11-01 2026-12-01`.
- Dezembro: `2026-12-01 2026-12-31` e `2026-12-31 2027-01-01`.

Exemplo após instalar uma versão validada da API/Node no ambiente certo
(NÃO executar este exemplo na imagem OAuth-stage, que não possui os arquivos):

```bash
GOOGLE_CALENDAR_AUDIT_ENABLED=true \
  node scripts/calendarLegacyReview.mjs 2026-12-01 2026-12-31
```

O modo **APPLY** é separado e exige que o operador leia/aceite os resultados
e forneça o `hashDaPrevia` EXATO, com `GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED=true`.
Ele volta a consultar as três fontes e aborta se o hash mudou. Escreve SOMENTE
`public.google_calendar_event_links` por transação única do período, com
`origem='legado_validado'`, `metodo_verificacao='revisao_manual_confirmada'`.
NÃO insere, altera ou apaga eventos no Google nem mexe em Firestore/PIX.

```bash
GOOGLE_CALENDAR_AUDIT_ENABLED=true \
GOOGLE_CALENDAR_LEGACY_LINKS_APPLY_ENABLED=true \
node scripts/calendarLegacyReview.mjs 2026-12-01 2026-12-31 \
  --apply --expected-sha256=HASH_DE_64_CARACTERES_VALIDADO_PELA_OPERACAO
```

As três divergências e os cancelamentos devem permanecer fora de qualquer
aprovação automática. Eventos legados sem vínculo confirmado **não** podem
ser alterados pela API direta.

## Regras de ativação

**Não ligar tudo de uma vez.** Ao iniciar canário, todas as flags globais
OAuth, DIRECT_WRITE, QUEUE e WORKER precisam estar true. Além disso, habilitar
somente a flag individual do fluxo verificado. Para criação de novos bookings,
exigir `GOOGLE_CALENDAR_CUTOVER_STARTED_AT=AAAA-MM-DDTHH:MM:SS-03:00`
na transição real. Só uma linha de outbox **recém inserida depois desse instante**
e ainda sem tentativa ou evento pode gerar autorização. Reservas anteriores
não ganham permissão de criação por mera ausência de vínculo.

1. Revisar e integrar PRs base, validar CI e gerar imagem em tag exclusiva;
   evitar imagens flutuantes. Conservar a tag e o Compose anteriores.
2. Implantar **primeiro com flags diretas false** e testar OAuth, rotas,
   PIX, agenda e serviços sem chamadas diretas.
3. Fazer prévia única nos intervalos, revisar candidatos e autorizar somente
   importação legada. Conferir pós-importação via SELECT com contagens,
   sem dados pessoais.
4. Testar com **booking de teste autorizado**, evitando clientes reais.
   Primeiro fazer um canário de atualização/cancelamento em evento de teste
   vinculado; depois uma criação realmente nova com corte e autorização.
5. Habilitar gradualmente as flags individuais, monitorando
   `google_calendar_sync_operations` e as outboxes antigas.
6. Implantar o frontend atualizado na mesma janela em que for habilitado
   `GOOGLE_CALENDAR_DIRECT_REAGENDAR_ISENTO_ENABLED`. Frontend antigo envia
   `no-cors` ao GAS e pode duplicar a ação!
7. Testar criação PIX pago, criação isenta, cancelamento, reagendamento PIX
   pago, reagendamento sem PIX e alteração de serviço antes de remover GAS.
8. Em erro/timeout: NÃO reabilitar GAS para a mesma operação pendente, nem
   alterar manualmente a reserva, sem conciliação. O estado
   `aguardando_confirmacao` retém o evento para recuperação por GET.
9. Depois de confirmar todos os fluxos, desligar os workers antigos/Apps
   Script que poderiam disparar alterações concorrentes.

## Limites que continuam exigindo atenção

- Google, Firestore e PostgreSQL não compartilham uma transação distribuída.
  Em reagendamento sem PIX, o backend pode concluir a reserva local e retornar
  `sincronizacaoCalendar='pendente'` se a atualização externa não confirmar.
  Esse estado precisa ser observado e conciliado antes de retentativa manual.
- Operações em estado incerto não são reenviadas automaticamente. Isso prioriza
  integridade e ausência de duplicidade, mas exige monitoramento.
- Atualizar evento GAS legado exige `events.id` real, ETag, referência
  `evt_<agendamentoId>` exata na descrição, vínculo PG confirmado e flags.
- A revisão dos 3 casos divergentes não pode ser tratada como exclusão ou
  recriação. O histórico original da outbox pode diferir do serviço atual.
- Manter os backups atuais; jamais restaurar um backup antigo sobre PIX
  recebidos depois dele. Rollback preferencial é de imagem/configuração,
  preservando banco e dados financeiros.
- O serviço de rebook no backend depende dos testes de dados reais,
  especialmente mudança de serviço e alterações manuais posteriores no
  Google Calendar. Uma passagem no CI não comprova, sozinha, readiness do corte.

**Status final desta PR:** código de transição implementado e testável,
mas sem aprovações em lote, sem cutover e sem desligamento GAS em produção.
