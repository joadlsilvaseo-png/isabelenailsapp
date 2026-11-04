# Reagendamento de PIX pago — missão PR #22

## Funcionalidade

Cliente e profissional podem reagendar **data e horário** de um agendamento
confirmado com **sinal PIX pago**, sem emitir nova cobrança, estornar, cancelar
ou perder o pagamento conciliado.

- O serviço original não pode ser trocado por essa operação. Alterar Serviço
  permanece tarefa independente (PR #20).
- O horário de início e a duração preservada são validados no backend conforme
  expediente vigente, bloqueios manuais e regras de dezembro.
- O mesmo `calendarEventId` / `eventId` é usado no Google Apps Script que
  criou o evento; não existe chamada `AGENDAR` nem outro evento novo.
- A funcionalidade é desligada por padrão. Só aparece na interface quando a
  API publicada confirma `GET /agendamentos/reagendar/config`.

## Validação com Apps Script REAL — 04/11/2026

Utilizando a URL já configurada no `pixCalendarWorker.js`, foi criado um
evento totalmente fictício com id
`evt_teste_pix_1793824531_28939`:

1. `AGENDAR` → `{ok:true,status:"AGENDADO",eventId,googleEventId}`
2. `REAGENDAR` → `{ok:true,status:"REAGENDADO",eventId}`
3. `CANCELAR` → `{ok:true,status:"CANCELADO",eventId}`

O teste demonstrou suporte a todas as ações pelo mesmo endpoint e
identificador interno. A API agora exige `ok:true`,
`status:"REAGENDADO"` ou resposta equivalente explícita e o mesmo
`eventId`. A execução não inspecionou independentemente o Google Event ID
depois do reagendamento ou a exclusão física após o cancelamento.

Consulta **somente leitura** na VPS mostrou 58 reservas com cobrança paga
e estado confirmado; as 58 possuem registro de Calendar enviado na
`pix_calendar_outbox`. Isso não demonstra que todos os eventos ainda
existem fisicamente no Google Calendar, mas confirma os vínculos no banco.

## Protocolo durável — Migração 021

`public.pix_reagendamentos_pagos` guarda UUID idempotente, agendamento,
cliente, serviço, cobrança, reserva, `eventId`, origem, destino, lease,
estado e erros para retentativas.

1. API autentica cliente ou administradora, valida pagamento
   `pix_cobrancas.estado='paga'`, reserva `confirmada`, vínculo da
   mesma cobrança/cliente/agendamento/serviço e outbox Calendar enviada.
2. Postgres bloqueia ambas as datas. Conserva a reserva original e cria
   uma reserva protetora para o destino; se os intervalos se sobrepõem,
   amplia a reserva original temporariamente para cobrir ambos.
3. Commit da operação durável. Worker chama `REAGENDAR` no Google
   Apps Script **existente** e só avança após confirmação explícita.
4. Firestore atualiza data/hora/status `reagendado` com marcador de
   operação. Os campos do sinal, cobrança, preço pago e identificadores
   não são modificados.
5. Postgres, em transação, substitui o intervalo original pelo destino,
   libera a reserva de proteção e conclui a operação. Por fim limpa o
   marcador Firestore. O worker pode retomar qualquer fase após timeout.
6. Cancelamento administrativo ou da cliente é impedido enquanto a
   operação PIX não foi concluída. Chamadas concorrentes para a mesma
   reserva são recusadas pela chave e índice único de operação pendente.

**Falha antes da confirmação do Calendar**: mantém ambos os horários
protegidos e tenta novamente. **Falha do Firestore após Calendar**:
mantém a operação `calendar_enviado`, sem reenviar a ação externa ao
retomar. **Falha da transação PostgreSQL após Firestore**: mantém o destino
bloqueado até conseguir concluir; não perde nem duplica o pagamento.
Falhas persistentes exigem análise administrativa da fila; a rotina
prefere manter horários bloqueados a permitir reservas conflitantes.

## Testes automatizados

`.github/workflows/validar-backend.yml` valida Node, frontend, regressões
de cancelamento, e executa PostgreSQL **17 temporário** com a migração
007 (exclusão de horários) e a nova 021.

Casos integrados: destino em outro dia, destino parcialmente sobreposto,
chave repetida, operação concorrente, conservação do sinal, falha do
Apps Script antes da confirmação, falha posterior Firestore, falha de
UPDATE PostgreSQL após atualização Firestore e recuperação do worker
sem nova cobrança e sem segunda chamada ao Calendar confirmado.

Todos os dados do teste são sintéticos; nenhuma cobrança Mercado Pago,
cliente ou evento Google Calendar real é utilizado pelo CI.

## Publicação segura

O fluxo de deploy `infra/scripts/atualizar-vps-pix.sh` aplica preflight
da migração 021, realiza backup PostgreSQL e da imagem/Compose,
e só então aplica SQL e recria a API mantendo as demais variáveis.
O script **não altera automaticamente as flags financeiras** e
**não liga** reagendamento PIX pago por padrão.

Para ativar explicitamente no deploy, utilizar
`ENABLE_PIX_PAID_RESCHEDULE=true` junto com `BRANCH=main`
ao executar a **versão atualizada** do script. Esse opt-in acrescenta ao
overlay apenas `PIX_REAGENDAMENTO_PAGO_ENABLED=true`, mantendo
PIX de produção, credenciais e volumes iguais aos anteriores.

Não tentar ativar a flag com a API antiga ou sem migrar a 021.
A interface PWA atualizada consulta a API antes de liberar o botão.
A função Alterar Serviço (#20) não é incluída nesta publicação.

## Observação operacional

Em situação de erro persistente, conferir
`SELECT operation_id, estado, ultimo_erro, criado_em FROM public.pix_reagendamentos_pagos WHERE estado <> 'concluida';`
em transação de somente leitura. Não apagar manualmente as reservas
de proteção ou o registro da operação sem conciliar o Google Calendar.

A versão atual do código ainda requer implantação efetiva na VPS para
ficar ativa; merge no GitHub por si só **não implanta o backend Node.js**.
