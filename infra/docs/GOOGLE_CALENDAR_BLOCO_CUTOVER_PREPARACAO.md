# Bloco de transicao operacional Google Calendar — preparacao segura

**Estado em 08/11/2026:** implementacao isolada de seguranças, idempotencia e preflight. **Nao** substitui Apps Script, nao possui rota HTTP, nao inicia jobs e nao realiza escrita real. PR empilhada na #51, que depende das PRs #50, #49, #48 e #45.

## Entregas deste bloco

### 1. Confirmacao transacional de evento Google novo

`infra/backend/src/googleCalendarRegistroConfirmado.js` exporta `concluirOperacaoGoogleConfirmada`, operacao futura **nao invocada por qualquer worker**. Uma mesma transacao PostgreSQL:
- Bloqueia a operacao existente por `operation_id` usando `FOR UPDATE`;
- Exige `fingerprint_pedido`, calendario, marcador privado e ID deterministico da VPS para novas criacoes;
- Recusa estado `pendente`, `conflito`, `dispensada` e `falha_permanente`;
- Para `reagendar`/`alterar_servico`, exige vinculo **VPS ativo ja confirmado**, evitando apropriar evento legado;
- Em `criar`, grava `google_calendar_event_links` com `ON CONFLICT DO NOTHING` e verifica correspondencia exata antes de concluir;
- Marca `google_calendar_sync_operations` como `concluida` somente apos verificar o vinculo;
- Garante que repetir uma operacao ja concluida valida o mesmo vinculo e nao grava duas vezes.

**Limite: esse metodo recebe um objeto `evento` fornecido pelo backend.** Ainda sera necessario ligar esse comprovante a `events.get` do Google num fluxo exclusivamente servidor para impedir fabricacao por entrada HTTP. A funcao nao e endpoint e nao pode ser usada com payload de cliente. Nao confirma cancelamentos; o procedimento de DELETE ainda precisa de recuperacao propria.

### 2. Preflight fail-closed por fluxo

`infra/backend/src/googleCalendarCutoverReadiness.js` exporta `avaliarPreflightCutover`: calcula **somente diagnostico**, sem executar qualquer alteracao. Para qualquer fluxo, exige cumulativamente:

- Auditoria completa de eventos com `vinculo_confirmado`, sem candidatos nem ambiguidades;
- OAuth conectado e calendario correto;
- Nenhuma pendencia do Apps Script nem operacao nova em estado aberto;
- Flags globais `GOOGLE_CALENDAR_OAUTH_ENABLED=true`, `GOOGLE_CALENDAR_DIRECT_WRITE_ENABLED=true` e `GOOGLE_CALENDAR_CUTOVER_ENABLED=true`;
- **Aprovacao explicita e flag independente** por fluxo.

Sete fluxos tratados separadamente:

| Fluxo | Flag futura |
|---|---|
| Criacao PIX pago | `GOOGLE_CALENDAR_CUTOVER_CRIACAO_PIX_PAGO` |
| Criacao de cliente isenta de PIX | `GOOGLE_CALENDAR_CUTOVER_CRIACAO_ISENTO` |
| Criacao sem PIX | `GOOGLE_CALENDAR_CUTOVER_CRIACAO_SEM_PIX` |
| Reagendamento PIX pago | `GOOGLE_CALENDAR_CUTOVER_REAGENDAMENTO_PIX_PAGO` |
| Reagendamento sem PIX | `GOOGLE_CALENDAR_CUTOVER_REAGENDAMENTO_SEM_PIX` |
| Alteracao de servico | `GOOGLE_CALENDAR_CUTOVER_ALTERACAO_SERVICO` |
| Cancelamento | `GOOGLE_CALENDAR_CUTOVER_CANCELAMENTO` |

**Nenhuma dessas flags esta ligada, nem inserida no Docker Compose, nem consultada pelos workers atuais.** Mesmo que um diagnostico retorne `pronto=true` em simulacao, nao autoriza ativar produção: ainda faltam conciliacao real, operacoes legadas, roteamento por fluxo, garantias de retry e rollback.

### 3. Testes automatizados

- `infra/backend/test/googleCalendarRegistroConfirmado.test.js`: 13 testes com PostgreSQL simulado: transacoes, idempotencia, vinculo, troca de identidade, colisao, operacao preexistente e bloqueio de legado.
- `infra/backend/test/googleCalendarCutoverReadiness.test.js`: 8 testes de travas de transicao e aprovacao por fluxo.
- Ambas suites integradas ao `npm test` e ao CI.

## Fluxos reais ainda usando Apps Script

A inspecao do codigo identificou:
- Worker `pixCalendarWorker.js`: criacao para PIX pago/isento e cancelamento via Script.
- `pixReagendamentoPagoOperacao.js`: reagendamento apos PIX pago com `URL_APPS_SCRIPT`.
- `agendamentoAlteracaoServico.js`: usa `REAGENDAR` para PIX, `ATUALIZAR` para eventos sem PIX, com contratos de retorno distintos.
- `agendamentoCancelamentos.js`: ID legado `evt_<agendamentoId>` usado como fallback.
- Agendamentos comuns e reagendamentos sem PIX podem manter chamadas Apps Script a partir do frontend e precisam de inventario especifico antes do corte.

**Nao substituir um desses caminhos isoladamente:** os fluxos de sinal, bloqueio de horarios, status de Firestore e calendario participam de transacoes logicas diferentes. Trocar so a chamada HTTP pode deixar a operacao paga confirmada em um lugar e pendente em outro.

## Plano do corte real — somente apos revisao e verificacao

1. Conciliacao read-only na VPS por janelas e tipo (com migracao 024 aplicada previamente em janela aprovada, backup verificavel e rollback).
2. Resolver cada caso historico, com `events.id` real verificado; registrar vinculos confirmados de eventos legados sem equipara-los a `isabele-vps`.
3. Implementar orquestracao duravel com `SKIP LOCKED`, heartbeat/leases, confirmacao por `events.get` depois de erro incerto, testando persistencia da intencao **antes** do POST Google e gravação do resultado depois.
4. Definir estratégia completa para criações isentas, pagas e sem PIX, reagendamentos, troca de serviço e cancelamentos. Cada rota de producao deve selecionar **uma unica autoridade de escrita**, nunca chamar Apps Script e API Google para o mesmo evento.
5. Testar contas e eventos de teste separados; reconciliar os resultados, validar metricas, feature flags e rollback.
6. Autorizar expressamente o deploy e a liberacao por fluxo; somente quando nenhum caminho depender de GAS, apos observacao de estabilidade, desabilitar Apps Script.

### Alertas encontrados

- Os eventos historicos sem `extendedProperties.private` **nao podem ser atualizados** pelo adaptador novo da Fase 2.1. Fazê-lo requer um contrato de legado que valide cada `events.id` com evidencias e/ou reidentifique o evento explicitamente, **sem recriacao automatica**.
- Contadores e relatório apenas do ultimo periodo nao comprovam conciliacao de toda a história. A consulta de cutover deve receber um documento de cobertura e confiabilidade com janelas explicitamente auditadas.
- O retorno `pronto` e apenas simulado/teorico ate que a validação operacional e o roteamento sejam implementados. **Nao habilitar flags de escrita em producao.**

## Producao atual

- OAuth do Google Calendar ja autorizado e leitura testada.
- API em imagem `isabele-nails-api:oauth-stage-529a91d3`.
- Migracao 023 instalada na VPS, **024 nao instalada**.
- Escrita direta e cutover continuam desativados.
- Nenhum modulo novo desta PR foi implantado na VPS; Apps Script continua ativo.
