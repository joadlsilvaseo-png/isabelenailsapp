# Mapa de fluxos legados — bloqueios para o cutover Google Calendar

**Origem:** inspeção dos arquivos do repositório em 08/11/2026. **Não é um relatório de dados de produção.** Os cenários com clientes reais e a versão exata do Apps Script publicado na conta Google ainda precisam ser confirmados em leitura/auditoria posterior.

## Pontos ativos que ainda dependem do Apps Script

| Fluxo | Código principal | Situação observada | Risco na migração |
|---|---|---|---|
| Agendamentos sem PIX / determinados caminhos do cliente | `agendamento.js` (trecho após o tratamento do reagendamento PIX pago) | Faz `fetch(googleScriptUrl, {method:'POST', mode:'no-cors', body: ...})` diretamente do navegador | O navegador **não consegue comprovar a confirmação** do Apps Script nessa modalidade. Se também for gravado na VPS, existe risco de duplicação |
| Criação PIX paga / sinal isento | `infra/backend/src/pixCalendarWorker.js` e `agendamentosIsencaoPix.js` | Outbox `pix_calendar_outbox`, ação `AGENDAR` para Apps Script, ID histórico `evt_<agendamentoId>` | Não tratar `evt_...` como `events.id` do Google, não ligar novo writer enquanto outbox antiga puder criar evento |
| Cancelamento | `agendamentoCancelamentos.js` → `pixCalendarWorker.js` | Saga cancelamento em PG e worker enviam `CANCELAR` para Apps Script. Há fallback para `evt_<agendamentoId>` | Se a criação antiga estiver incerta, excluir pelo ID novo pode errar ou recriar evento; confirmar vínculo antes |
| Reagendamento PIX pago | `pixReagendamentoPagoOperacao.js` | Worker de operação `pix_reagendamentos_pagos` chama Apps Script antes de concluir Firestore/PG | Preservar a mesma reserva e cobrança; evento antigo pode divergir do ID Google; bloquear dupla execução |
| Alteração de serviço | `agendamentoAlteracaoServico.js` | Usa `REAGENDAR` via script PIX ou `ATUALIZAR` via URL configurada para outras reservas | Precisa preservar duração, conflitos, status PIX e a confirmação do mesmo evento no Google |
| Registro Firestore PIX | `pixConfirmacaoFirestore.js` | Escreve `calendarEventId: evt_<agendamentoId>` | Campo histórico não deve ser sobrescrito automaticamente pelo ID de evento novo antes de migração coordenada |
| Deploy e configuração | `infra/scripts/atualizar-vps-pix.sh` e arquivos privados Compose | Flags e endpoint de Apps Script existentes | Não alterar/desligar flags antigas antes de garantir cobertura de todos os fluxos |

## Observações técnicas importantes

- `no-cors` devolve resposta opaca e não comprova o sucesso de gravação remota. Apenas substituir a chamada por outra também não garante atomicidade com Firestore e PostgreSQL.
- `evt_<agendamentoId>`, `calendarEventId`, `event_id`, `iCalUID` e o `events.id` da API Google **não são sinônimos**; o novo vínculo verificado da migração 024 não deve ser preenchido por simples cópia.
- O evento novo criado pelo backend deve usar `id` determinístico, marcador privado e controle de versão; o algoritmo do adaptador não resolve sozinho eventos antigos sem marcador.
- O worker antigo deve ser impedido de processar a **mesma reserva** no instante em que a rota passa a ser nova. Isso exige desligamento/pausa por caminho e verificação de filas existentes, não apenas flags globais.
- Se a API Google retorna timeout após potencial escrita, o sistema deve marcar `aguardando_confirmacao` e reconsultar o evento. Não enviar à API Google *e* ao Apps Script como retry automático.
- O rollback do corte precisa distinguir eventos `origem=vps` e `legado_validado`. Eventos novos da VPS **não voltam** ao Apps Script apenas porque a flag foi desativada; ficam bloqueados até recuperar a integração.
- Agendamento/PIX podem continuar funcionando em produção **na implementação antiga**, pois esta PR não modifica nenhuma chamada acima.

## Ordem recomendada da transição efetiva

1. Inventário remoto de eventos e correspondência dos identificadores reais; resolver candidatos ambíguos.
2. Pré-validação das sagas de PIX e horários, com backup, testes e migrações 024/025 controladas.
3. Encapsular o `agendamento.js` para que o frontend não faça nova gravação remota fora de uma API protegida, com compatibilidade das reservas antigas e sem habilitar escrita ainda.
4. Integrar criação de novos agendamentos numa operação idempotente, com vínculo transacional e confirmação de Firestore/PG; teste com evento **fictício controlado**, não com cliente real.
5. Integrar reagendamento, alteração de serviço e cancelamento com verificação de estado/ETag, recuperação de timeouts e bloqueios de conflito; validar cada tipo.
6. Roteamento monitorado por tipo de reserva/geração de evento e flags distintas; impedir que GAS e Google escrevam o mesmo agendamento.
7. Comparar agenda/PG/Firestore em leitura, liberar um fluxo por vez; desligar Apps Script somente quando não houver mais chamadas, filas pendentes ou débitos de sincronização.

**Situação:** mapeamento de código concluído, mas levantamento da produção/implantações Apps Script e conciliação de clientes **ainda pendentes**. Este documento é uma trava de decisão, não autorização de deploy.
