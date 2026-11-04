# Reagendamento de agendamento com sinal PIX pago — implementação protegida

A produção **não** está autorizada para reagendar PIX pago até ser possível
atualizar o MESMO evento no Google Calendar com confirmação legível pela API.
O bloqueio anterior de PIX no frontend e backend foi mantido intencionalmente.

## O que foi preparado

- Testes para validar `pix_cobrancas.estado = 'paga'`, `pix_reservas.estado = 'confirmada'`,
  e a correspondência da cobrança, cliente, reserva, agendamento e serviço.
- Uma tentativa de reagendamento nunca usa o fluxo para criar/emitir uma
  nova cobrança, nem pode mudar o serviço por essa via.
- Contrato de `REAGENDAR` com `eventId` fixo, `operationId` idempotente,
  data/hora e duração.
- A API valida a resposta JSON explícita do Apps Script, inclusive o mesmo
  `eventId`. Texto de sucesso não verificável ou confirmação de outro evento
  é rejeitado.
- Flag `PIX_REAGENDAMENTO_PAGO_ENABLED` (padrão **desligado**) e URL
  `PIX_REAGENDAMENTO_PAGO_APPS_SCRIPT_URL` exigem validação integrada.
- `GET /agendamentos/reagendar/config` autenticado retorna o estado da flag
  sem tocar nos registros financeiros.

## Teste controlado do Apps Script utilizado pelo PIX — 04/11/2026

Na VPS, utilizando a implantação já presente no `pixCalendarWorker.js`,
o usuário executou três operações com o identificador **exclusivamente fictício**
`evt_teste_pix_1793824531_28939`. Resultados:

- `AGENDAR`: `{"ok":true,"status":"AGENDADO","eventId":"evt_teste_pix_1793824531_28939","googleEventId":"ai8h5crk1g0obb05lt8l7n4ecg@google.com"}`
- `REAGENDAR`: `{"ok":true,"status":"REAGENDADO","eventId":"evt_teste_pix_1793824531_28939"}`
- `CANCELAR`: `{"ok":true,"status":"CANCELADO","eventId":"evt_teste_pix_1793824531_28939"}`

**Confirmado**: a implantação de `AGENDAR/CANCELAR` reconhece também
`REAGENDAR` e devolve o mesmo `eventId` interno. O validador da API
foi ajustado para aceitar a resposta real `status:"REAGENDADO"`, exigindo
`ok:true` e a identidade esperada. O teste não envolveu cliente real,
PIX ou alterações em PostgreSQL/Firestore.

**Ainda não comprovado pela execução**: que o evento permaneceu com o mesmo
Google Calendar ID após o reagendamento, que o horário foi efetivamente
atualizado ou que a exclusão final removeu o evento (as respostas de
sucesso são do Apps Script, sem inspeção independente). Não presumir
idempotência sob timeout ou concorrência.

**IMPORTANTE**: a sincronização transacional entre PostgreSQL,
Firestore e Calendar para PIX pago ainda não está implementada. A flag
no PR retorna sempre `false` por segurança; **nenhuma variável de ambiente
habilita o reagendamento pago** neste estado. A tela e a API de produção
continuam bloqueando este caminho.

## Impedimento para liberação

A API de produção atualmente envia AGENDAR e CANCELAR para uma implantação de
Google Apps Script iniciada por `AKfycbzOx...`. O frontend REAGENDAR aponta
para outra implantação, iniciada por `AKfycbwUw...`. Ambos podem usar o mesmo
calendário, mas isso não compartilha os mapas `reserva_<eventId>` das Script
Properties entre projetos.

**O endereço usado pelo worker PIX ainda não foi comprovado para REAGENDAR
um evento existente.** A chamada de reconhecimento de ATUALIZAR anterior
mostrou que ela não estava disponível naquele endpoint. Além disso, o
frontend usa `no-cors` no reagendamento comum, sem obter confirmação real
do Calendar. Isso é inadequado para movimentar um agendamento pago.

Não habilitar a flag ainda. Falta criar um caminho de reagendamento pago que
segure origem e destino durante a operação, preserve `cobranca_id`/
`pixReservaId` e os valores financeiros, e tenha recuperação idempotente
em caso de falha entre PostgreSQL, Firestore e Calendar. Só após essa fase
poderá ser removido o bloqueio da tela.

## Requisitos de aceite para a próxima fase

1. Script de criação PIX consegue executar REAGENDAR no **mesmo** `eventId`
   e devolver `{ok:true,reagendado:true,eventId}` sem duplicar, tratar
   `operationId` repetido idempotentemente.
2. Backend reconcilia o pagamento pago, atualiza a mesma reserva mantendo
   `cobranca_id`, nunca chama `pix/emitir`/Orders nem estorna.
3. A data de origem permanece reservada até confirmação consistente da data
   nova; a data nova não pode ser ocupada por outra cliente durante a operação.
4. Reagendamento atende bloqueios administrativos, duração do serviço, regras
   normais e as exceções especiais de dezembro.
5. Testes de falha de HTTP, timeout, commit PostgreSQL, gravação Firestore,
   operação repetida e concorrência. Não usar clientes reais nos testes.
6. Merge/deploy somente após CI verde, Apps Script identificado e teste
   controlado de ponta a ponta com evento e cobrança fictícios.

O PR de Alterar Serviço (#20) é separado e também fica sem merge até sua
própria validação do Calendar. Nenhum dado real foi alterado por este trabalho.
