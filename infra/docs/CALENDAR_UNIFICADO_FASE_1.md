# Calendar unificado — Fase 1: diagnóstico de arquitetura e plano de migração

**Data de preparação:** 08/11/2026  
**Base analisada:** `main` no merge `618972cf25e6bb63915a8fec24fc71023f55f7da` (PR #42 integrada)  
**Status:** proposta técnica de preparação — **nenhuma alteração de execução, migração, configuração, Apps Script, VPS ou frontend** nesta fase.

## 1. Objetivo e fronteira desta etapa

Preparar a migração progressiva das ações de agenda para uma API central e um **único projeto Apps Script na conta da Isabele**, respeitando os eventos existentes. O destino final deve operar sobre o calendário real da Isabele, identificado explicitamente, e não depender implicitamente de `getDefaultCalendar()`.

Escopo futuro: criar, reagendar, cancelar e alterar serviço (incluindo duração); acompanhar estados; tratar erros, retentativas, conflitos e reconciliação; preservar PIX pago, isenção, pagamentos, bloqueios, serviço e disponibilidades.

**Esta PR de Fase 1 é documental.** Não criar a migração SQL, workers, novos endpoints, script GAS ou flags nesta etapa. Não executar testes de falha, nem provocar eventos de produção: tais testes serão preparados e executados somente na implantação controlada.

## 2. Inventário verificável da implementação atual

| Fluxo | Arquivo atual | Situação e ponto de atenção |
|---|---|---|
| Criação PIX paga ou isenta | `infra/backend/src/pixCalendarWorker.js` + `pix_calendar_outbox` | Backend chama endpoint legado com ação AGENDAR; já há outbox e retentativas |
| Criação com isenção | `infra/backend/src/agendamentosIsencaoPix.js` | Grava Firestore/reserva e enfileira Calendar; `calendarEventId` derivado de ID estável |
| Reagendamento sem cobrança PIX (inclui isentas) | `agendamento.js`, `agendamentosApi.js`, `infra/backend/src/agendamentosIsencaoPix.js` | API muda Firestore e reserva ANTES da chamada GAS direta do browser, que usa `no-cors`. Não há confirmação de evento nem retentativa durável do REAGENDAR |
| Reagendamento PIX pago | `infra/backend/src/pixReagendamentoPagoOperacao.js` + migração 021 | Worker durável: reserva origem/destino; Calendar, Firestore e banco por etapas; já preserva cobrança e evita duplo PIX |
| Cancelamento | `infra/backend/src/agendamentoCancelamentos.js` + `pixCalendarWorker.js` + migração 012 | Saga durável e fila de cancelamento Calendar existente; preservar |
| Alteração de serviço | `infra/backend/src/agendamentoAlteracaoServico.js` + migração 020 | Saga com confirmação explícita; seleciona script/ação conforme origem, hoje com destinos distintos |
| Redirecionamento público /api | `vercel.json` | Vercel reescreve chamadas para API VPS; não alterar sem validação |
| Rotas da API | `infra/backend/src/server.js` | Há rotas separadas; não substituir de uma vez |

**Incompatibilidades comprovadas no código e no Apps Script fornecido na conversa:**

- O script de criação da conta antiga usa a propriedade `isabele_evento_<eventId>`, identifica explicitamente o calendário da Isabele e devolve JSON para AGENDAR/REAGENDAR/CANCELAR.
- O script atual da conta da Isabele usa `reserva_<eventId>` no **próprio projeto**, `getDefaultCalendar()`, retorno de **texto** para AGENDAR/REAGENDAR/CANCELAR e JSON para ATUALIZAR.
- As propriedades de scripts diferentes não são compartilhadas; só trocar a URL pode tornar eventos antigos inacessíveis.
- O script da Isabele suporta ATUALIZAR com `operationId`; o script antigo da outra conta não contém a mesma ação.
- O frontend chama uma implantação GAS diferente da usada pelo `pixCalendarWorker.js`. O worker PIX pago ainda importa uma URL fixa de `pixCalendarWorker.js`, apesar de existir parâmetro opcional de URL em outro módulo.
- O script antigo contém função legada `sincronizarCancelamentos` com acionador periódico e outro calendário. Verificar os gatilhos e os efeitos antes de desativar qualquer coisa.
- A operação de 07/11/2026 relatada era isenta. O código demonstra risco de divergência, mas **a causa individual não foi comprovada por logs**; não alterar registros históricos automaticamente.

## 3. Invariantes obrigatórias (não negociar)

1. **Sem mudança financeira:** não emitir/estornar PIX, alterar cobrança, valor pago, isenção, vínculo de reserva ou status financeiro por causa da migração.
2. **Sem perda de disponibilidade:** respeitar duração real, expediente, bloqueios manuais, regras específicas de dezembro, proteção direcional de 15 min e exceção de sequência para a mesma cliente. Não reutilizar consultas legadas com buffer simétrico por engano.
3. **Sem duplicação do Calendar:** manter um `eventId` de aplicativo por agendamento e, quando conhecido, o Google Event ID do mesmo evento; jamais criar outro evento como fallback de REAGENDAR/ATUALIZAR/CANCELAR.
4. **Uma operação por agendamento em processamento:** evitar REAGENDAR, CANCELAR e ATUALIZAR simultâneos; travar horários de origem e destino conforme a ação; manter proteção no estado incerto até conciliação.
5. **Sucesso verificável:** `ok: true` + ação/status esperado + mesmo `eventId` + leitura/validação do evento real (data, duração, título quando aplicável); sem depender de `no-cors`/texto opaco ou do simples HTTP 200.
6. **Operação recuperável:** idempotência por `operationId`, retomada após queda da API/timeout; sem reaplicar o efeito externo após confirmação registrada.
7. **Segurança:** autenticação Firebase e autorização cliente/admin na API; backend como único chamador do GAS; controlar requisições GAS com segredo/assinatura validado no script, protegido em variáveis/Script Properties; não publicar segredos ou dados pessoais em logs.
8. **Compatibilidade:** API antiga e frontal atuais continuam funcionais até ativação por flags e preparação real dos vínculos; só remover os caminhos legados após validação e período de observação.

## 4. Contrato do Apps Script alvo (Fase 2)

- Projeto **da conta da Isabele**, calendário explicitamente selecionado por ID e permissão de escrita verificada.
- Ações: `AGENDAR`, `REAGENDAR`, `CANCELAR`, `ATUALIZAR`; nunca inferir ação de uma chamada incompleta.
- Entrada mínima: `acao`, `eventId`, `operationId` (para operações mutáveis), payload específico; início com fuso São Paulo validado e duração inteira.
- Saída JSON comum: `{ok, status, eventId, operationId, googleEventId?, repeated?, errorCode?, error?}`. Erro de aplicação deve responder `ok:false` e código estável; não expor cliente, credenciais ou rastros em resposta.
- Repetição idempotente deve comparar assinatura e estado real. Para evento inexistente/ambíguo, **erro explícito sem criação de substituto**.
- Resolver vínculo por registro validado, ID Google quando autorizado, tag/descrição/identidade e instantâneo de origem; busca por título+data só com provas suficientes e sem escolher resultado ambíguo.
- Não usar a nova data de destino para localizar o evento ainda na data original.
- As ações não podem tratar `AGENDAR` com `eventId` já cancelado como autorização para recriação.
- Verificar e documentar triggers históricos; não desativar nada antes do inventário.

## 5. Proposta de migração PostgreSQL (planejamento; NÃO criar/aplicar agora)

**Migração candidata:** `infra/migrations/023_calendar_operacoes_unificadas.sql` (confirmar disponibilidade do número quando implementar). Incremental, transacional, aditiva; nunca `DROP`/`TRUNCATE` ou `UPDATE` em lote de registros históricos.

Estruturas planejadas:

1. **`calendar_operacoes`**: `operation_id` UUID PK, `agendamento_id`, `solicitante_uid`, `tipo` (AGENDAR/REAGENDAR/CANCELAR/ATUALIZAR), `origem_fluxo` (pix_pago/isento/legado), snapshot imutável de origem e destino (data, intervalo, serviço), `event_id`, vínculo opcional ao Google Event ID, `estado`, `tentativas`, `proxima_tentativa_em`, `lease_ate`, `erro_codigo`, `erro_resumo`, datas de criação/atualização/confirmação/encerramento.
2. **`calendar_vinculos`**: `agendamento_id` / `event_id` únicos, `google_event_id` quando verificado, `calendar_id`, `origem_script`, `status_verificacao` (nao_verificado/verificado/divergente/revisao_manual), `verificado_em`. Preenchimento seguro: começa sem inventar o Google Event ID.
3. **`calendar_operacao_historico`**: log técnico append-only por operação, etapa, código de resultado e horário, sem payloads financeiros, tokens, nomes ou emails de clientes. Só dados mínimos.
4. Índices em `(estado, proxima_tentativa_em, criado_em)`, vínculo por `agendamento_id`, unicidade parcial de operação ativa por agendamento e suporte a `FOR UPDATE SKIP LOCKED`. Restrições/estados devem contemplar pendência de reconciliação e limpeza pós-confirmação.

**Observação de arquitetura:** evitar duas filas ativas concorrentes para a mesma ação. O novo coordenador deverá orquestrar ou delegar os workers existentes (migrações 009/012/020/021), sem duplicá-los. A transição de registros antigos será gradual e sem reescrever histórico financeiro.

## 6. Estados e recuperação — contrato a implementar na Fase 3/4

`solicitada` → `horarios_protegidos` → `calendar_confirmado` → `dados_conciliados` → `concluida`.

Estados auxiliares: `tentativa_programada`, `reconciliacao_necessaria`, `falha_definitiva`. Não marcar `concluida` só porque o envio HTTP aconteceu. Timeout de rede após tentativa de Calendar é **resultado incerto**, não é prova de que a ação falhou.

- Falha antes de atingir o Calendar: retentar com mesma `operationId`, respeitando limites e backoff; não liberar o destino enquanto houver dúvida.
- Calendar confirmou, Firestore/PostgreSQL falhou: retomar somente a etapa local, preservando origem/destino até finalizar; sem novo AGENDAR/REAGENDAR cego.
- Evento não encontrado ou vínculo ambíguo: bloquear avanço e expor diagnóstico administrativo; não tentar criar segundo evento.
- Falha definitiva: finalizar com motivo somente quando houver certeza do estado externo e política segura de liberação. Estado incerto requer revisão/reconciliação, não bloqueio silencioso infinito.
- Velocidade: API devolve rapidamente `202 + operationId` para operação durável; frontend consulta estado autenticado e mostra `Sincronizando`, `Em processamento`, `Concluído`, `Falha`. Polling com intervalo e limite explícitos; sem travar o navegador nem chamar GAS diretamente. Não prometer conclusão instantânea quando o serviço Google demorar.

## 7. Estratégia de vínculos legados

Antes de apontar **qualquer worker antigo** para o novo projeto, comprovar acesso ao mesmo calendário e preservar o relacionamento entre `eventId` e evento Google:

- Inventariar eventos por **origem conhecida**, usando `pix_calendar_outbox`, `calendarEventId` Firestore, vínculos `isabele_evento_` na conta antiga e `reserva_` no projeto da Isabele, além de tags/descrições do evento.
- Inspeção inicial só leitura, agregada por contagens. Não exportar lista de clientes, identificadores privados ou credenciais para GitHub.
- Para cada agendamento legado: validar identidade do calendário/evento, origem, data e duração. Marcar como `verificado`, `divergente` ou `revisao_manual`; não adivinhar.
- Só após comprovar acesso, realizar backfill progressivo e idempotente sob ferramenta auditável. Evento ausente: isolamento da operação para revisão; não gerar clone.
- **Não assumir** que a conta Isabele + `getDefaultCalendar()` corresponde ao calendário explícito da conta antiga.
- Inspecionar e reconciliar o caso de 07/11 separadamente; a migração em lote não pode corrigi-lo no escuro.

## 8. Implantação por expansão e flags (somente Fase 6)

1. Preflight de estrutura SQL e dependências, backup PostgreSQL/Compose/imagem, snapshot de configuração efetiva e procedimentos de recuperação. Preservar checkout VPS com mudanças locais, worktree e volumes existentes.
2. Implantar banco e backend de forma **aditiva**, com novo coordenador desligado; não apontar todos os serviços para novo GAS de imediato.
3. Configurar manualmente o Apps Script da Isabele, verificar calendário/credenciais/vínculos e retornos JSON com **eventos sintéticos isolados**. O código GAS não fica automaticamente implantado pelo GitHub.
4. Ativar por fluxo (isento primeiro; demais somente depois), sem retirar workers legados enquanto houver operações pendentes.
5. Só após backend comprovadamente pronto, publicar frontend e remover chamada GAS `no-cors` via `main`/Vercel. Não mergear frontend que exige backend não publicado.
6. Testar no momento da implantação: sucesso, falha de Apps Script, atraso/timeout incerto, evento não localizado, divergência de ID, concorrência, reinício worker, mesmos horários/cliente, PIX pago sem cobranças novas e isenção; rollback exercitado em ambiente seguro.
7. Acompanhar métricas e pendências. Rollback da imagem **não desfaz** alterações já feitas no Calendar; operação parcialmente confirmada exige conciliação, nunca replay cego.

## 9. Etapas seguintes e condição de aprovação

- **Fase 2:** versão auditável do Apps Script da Isabele e estratégia concreta de recuperação de vínculos; preparar código, não publicar sem validação.
- **Fase 3:** API/worker unificados e integração gradativa sem `no-cors`, preservando PIX e isenções.
- **Fase 4:** persistência e observabilidade SQL/Firestore, resiliência e prevenção de conflitos.
- **Fase 5:** interfaces cliente/admin de progresso e diagnóstico.
- **Fase 6:** testes reais controlados, backup, implantação VPS, validação e publicação web.

**Critério para encerrar a Fase 1:** revisão feita, plano no GitHub, branch e PR draft próprios, sem alterações de produção. Avançar somente após OK explícito do usuário.
