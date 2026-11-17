# Análise Web da Isabele — Contrato de eventos v1 (proposta)

**Fase:** 1, especificação documental; **sem alteração de código ou envio de novos eventos**.  
**Origem:** [diagnóstico de Fase 1](./analise-web-isabele-fase1.md).  
**Base de código:** main `7524d65c15ce2e909666d7cca572189c61d81ad5`, auditada em 17/11/2026.

## 1. Objetivo e princípios

Instrumentar a jornada do app para responder a perguntas concretas: quais categorias geram interesse, quantas clientes veem e utilizam sugestões inteligentes, quantas abrem “Ver todos os horários”, onde o fluxo de reserva interrompe e qual a diferença entre **interações observadas** e **reservas confirmadas oficialmente**.

**Padrões:**

- Eventos em inglês, minúsculas, **snake_case** e prefixo **booking_** para novos eventos da jornada. Manter eventos legados (**login**, **registro**, **gallery_*** etc.) inalterados nesta fase.
- Inicializar a coleta apenas nos contextos autorizados; diferenciar **role**, sem enviar Firebase UID, nome ou informações pessoais.
- “Agendamento concluído” é uma transição **autoritativa do backend**. Não inferir a partir de botão, cotação, reserva PIX, QR exibido, redirect ou visualização de tela.
- Eventos de interface podem ser perdidos por bloqueadores, navegador fechado ou falta de conexão. Nunca usar apenas GA4 para auditoria financeira/operacional.
- Não enviar parâmetros específicos da reserva, inclusive **data ISO e hora exata escolhidas**, identificador de agendamento, token, nome da cliente, telefone ou termo livre de pesquisa.
- Uma interação válida gera no máximo uma instância do seu evento por ação, mesmo quando a implementação dispara um **click()** programático.
- Instrumentação assíncrona e **fail-open**: indisponibilidade do Analytics jamais bloqueia agendamento, pagamento, navegação ou renderização.

## 2. Parâmetros padronizados

| Parâmetro | Valores esperados | Política |
| --- | --- | --- |
| **flow_type** | **new**, **reschedule** | Novo e reagendamento separados. Não presumir “new” quando existir parâmetro **reagendar**. |
| **actor_role** | **client**, **admin**, **unknown** | Não incluir ações de administradoras nos relatórios de cliente; permitir **unknown** apenas durante diagnóstico, não como base de funil. |
| **service_category** | Identificador curto controlado, normalizado da categoria ativa; **unknown** | Nunca enviar nome livre de serviço ou observações; validar contra categorias conhecidas. |
| **selection_source** | **suggestion**, **full_list** | Preencher apenas quando a escolha do horário for efetiva. |
| **payment_path** | **pix**, **exempt**, **not_applicable** | Só definir após o backend informar o caminho. |
| **time_bucket** | **morning**, **afternoon**, **evening** | Faixas amplas, sem horário exato. |
| **day_of_week** | **mon**, **tue**, **wed**, **thu**, **fri**, **sat**, **sun** | Só se necessário à análise; usar fuso da agenda **America/Sao_Paulo** e evitar data exata. |
| **issue_type** | **no_slots**, **availability_network**, **invalid_selection**, **pix_pending**, **pix_review**, **other** | Enumeração fechada; nunca enviar **error.message**, corpos da API ou texto digitado. |
| **seconds_to_slot** | Número inteiro >= 0, limitado e arredondado | Métrica opcional; tempo **ativo** até a seleção, não duração do PIX nem intervalo ausente do app. |
| **analytics_schema_version** | **1** | Permite compatibilizar futuras alterações de contrato. |

**Dimensões personalizadas propostas para registro no GA4** (seleção mínima): **flow_type**, **selection_source**, **service_category**, **payment_path** e, conforme avaliação, **actor_role**. Não registrar IDs exclusivos de clientes ou reservas como dimensões. Métrica personalizada opcional: **seconds_to_slot**. Validar quota, necessidade e nomes no GA4 antes de criar.

## 3. Catálogo priorizado — eventos de interface (Fase 2)

**P0:** indispensáveis para o primeiro painel. **P1:** adicionáveis após o MVP inicial.

| Prioridade | Evento proposto | Quando disparar exatamente | Arquivo/ponto de integração |
| --- | --- | --- | --- |
| P0 | **booking_flow_started** | Primeira entrada válida com serviço existente carregado; classificar **new/reschedule** e ator; uma vez por carregamento de jornada | [agendamento.js](../agendamento.js), após validar **serviceInfo**, **reagendarId**, papel |
| P0 | **booking_date_selected** | Clique real da usuária em uma data válida; não disparar pela seleção inicial automática ou pela renderização | [agendamento.js](../agendamento.js), listener em **datas** |
| P0 | **booking_suggestions_displayed** | Lista de sugestões realmente montada e **visível**, com pelo menos uma opção; deduplicar re-renderização da mesma tela | [agendamento.js](../agendamento.js), **carregarSugestoesHorarios** após **secao.hidden = false** |
| P0 | **booking_suggestion_selected** | Sugestão selecionada **e validada**: **selecionarDataAgendamento** retorna verdadeiro; não contar tentativa rejeitada | [agendamento.js](../agendamento.js), clique **data-agenda-sugestao** |
| P0 | **booking_all_times_opened** | Clique da usuária que expande **Ver todos os horários**, do estado fechado para aberto | [agendamentoPainelHorarios.mjs](../agendamentoPainelHorarios.mjs), callback do toggle; conectar na inicialização sem misturar com expansão programática |
| P0 | **booking_time_selected** | Seleção de horário habilitado concluída, classificando **selection_source**. O clique programático disparado por sugestão **não** deve ser contado como manual | [agendamento.js](../agendamento.js), seleção de horário e sinalização **horarioViaSugestao** |
| P0 | **booking_submit_clicked** | Clique válido no botão Confirmar depois das verificações básicas; a ação é intenção, não reserva confirmada | [pixCheckout.js](../pixCheckout.js) para **new**; [agendamento.js](../agendamento.js) para **reschedule** |
| P0 | **booking_quote_viewed** | Cotação PIX válida obtida em **/pix/cotacao** e apresentada; **não** existe reserva nesse ponto | [pixCheckout.js](../pixCheckout.js), **apresentarCotacao** |
| P0 | **booking_pix_qr_shown** | Retorno de emissão PIX com QR/código válido efetivamente exibido; **não** significa que foi pago | [pixCheckout.js](../pixCheckout.js), **mostrarPedido** |
| P0 | **booking_pix_confirmed_ui** | A UI reconhece **agendamentoConfirmado === true** devolvido pelo backend, uma vez por operação; **não** é a contagem autoritativa | [pixCheckout.js](../pixCheckout.js), **concluirAgendamento** |
| P0 | **booking_exempt_confirmed_ui** | API **/agendamentos/sem-pix** retorna agendamento confirmado e a UI recebeu sucesso; deduplicar retries | [pixCheckout.js](../pixCheckout.js), após resposta de **postApi("/agendamentos/sem-pix")** |
| P0 | **booking_reschedule_completed_ui** | A operação de reagendamento realmente concluiu na API; PIX pago exige conclusão confirmada pelo worker; não emitir ao iniciar sincronização | [agendamento.js](../agendamento.js), nas saídas de sucesso de **reagendarAgendamentoApi** e consulta do worker |
| P1 | **booking_service_selected** | Usuária seleciona serviço e aciona prosseguir para agendar; não emitir por renderização automática da lista | [categoria.js](../categoria.js), páginas de serviço legadas, pesquisa em [principal.js](../principal.js) |
| P1 | **booking_all_times_closed** | Usuária recolhe manualmente a grade após ter aberto | [agendamentoPainelHorarios.mjs](../agendamentoPainelHorarios.mjs) |
| P1 | **booking_unavailable_shown** | Tela apresenta disponibilidade vazia após consulta válida, evitando contar carregamento/erro como “sem horários” | [agendamento.js](../agendamento.js), renderização final dos horários |
| P1 | **booking_pix_copy_clicked** | Usuária efetivamente copia código PIX, sem enviar o conteúdo copiado | [pixCheckout.js](../pixCheckout.js), handler do botão Copiar |
| P1 | **booking_issue_shown** | Mensagem de erro/impedimento observável por tipo fechado em **issue_type** e etapa; não incluir conteúdo da resposta | [agendamento.js](../agendamento.js), [pixCheckout.js](../pixCheckout.js) |
| P1 | **booking_cancel_requested_ui** | Usuária solicita cancelamento, separado de cancelamento realizado pelo backend | [meu-perfil.js](../meu-perfil.js) |

**Nota importante de implementação:** o PWA já tem listeners para **data-agenda-sugestao**, seleção de datas, **agendamento-time**, botão **agendamento-button** e **agendamento-horarios-toggle**. A instrumentação deve ser um efeito lateral desses pontos. Não modificar condições de disponibilidade, pagamentos, tempos de retry, isenção, interações da agenda ou atualizações no Firestore.

## 4. Eventos que não devemos confundir

| Operação | Pode indicar | NÃO indica |
| --- | --- | --- |
| **booking_flow_started** | Início de interesse por um serviço | Intenção financeira ou reserva |
| **booking_suggestions_displayed** | Sugestões disponíveis à cliente | Escolha da sugestão |
| **booking_suggestion_selected** | Escolha efetiva via sugestão | Serviço pago ou confirmado |
| **booking_all_times_opened** | Preferência de ver a grade completa | Escolha de horário |
| **booking_submit_clicked** | Tentativa de avançar | Confirmação |
| **booking_quote_viewed** | Preço do sinal consultado | Hold PIX |
| **booking_pix_qr_shown** | Cobrança/QR apresentado | PIX pago |
| **booking_pix_confirmed_ui** | UI recebeu informação de confirmação | Todos os agendamentos oficiais (aba pode estar fechada) |
| **booking_exempt_confirmed_ui** | Retorno de sucesso de isenção na UI | Necessariamente todos os estados finais históricos |
| **booking_reschedule_completed_ui** | Operação existente reagendada | Novo agendamento criado |

**Fonte definitiva de sucesso de novos atendimentos:** coleção de agendamentos e dados operacionais consolidados no backend, sob controle de acesso. O quadro do GA4 permanece comportamental.

**Não emitir purchase ao criar um QR PIX ou pagar um sinal** sem antes definir modelagem de transação, valor e deduplicação compatível com a operação real.

## 5. Fórmulas e definições do painel

| KPI do painel | Fórmula de apresentação v1 | Observação |
| --- | --- | --- |
| Usuárias ativas | **activeUsers** do GA4 em páginas/fluxos de cliente válidos | Não equivale a contas reais cadastradas; cuidar de visitas administrativas, consentimento e cobertura |
| Acessos ao agendamento | Contagem de **booking_flow_started** com **flow_type=new** e **actor_role=client** | Eventos/ocorrências, não clientes únicas |
| Taxa de uso de sugestões — interações | **booking_suggestion_selected / booking_suggestions_displayed × 100** (exibir como **razão entre eventos**, não “percentual de clientes”) | Re-renderizações, seleções repetidas e múltiplas sugestões numa sessão exigem teste de deduplicação |
| Preferência pela grade | **booking_all_times_opened / booking_flow_started × 100**, como razão indicativa de ocorrências | Uma jornada pode abrir a grade mais de uma vez; não chamar de participação de pessoas sem deduplicação |
| Indicador de progressão ao checkout | **booking_quote_viewed / booking_submit_clicked × 100** (PIX apenas) | Não compara isentas com PIX; deduplicação por etapa/caminho |
| Resumo de reservas efetivas | Contagem de **novas confirmações autoritativas**, deduplicadas por agendamento, no período | Separar PIX pago e isento; **não** incluir simples reagendamentos |
| Cancelamentos | Contagem operacional de cancelamentos por regra de status/transição definida | Histórico de transições exige fonte apropriada; não inferir pelo status final isolado se desejar eventos no período |
| Tempo para escolher | Mediana e percentis de **seconds_to_slot** para jornadas válidas | Medir tempo ativo, não tempo até pagamento |
| Queda no funil | Relatório de **etapas por sessão/usuária** do GA4, se disponível, ou contagens de eventos rotuladas como tal | Não dividir usuários GA4 por agendamentos backend para gerar percentual supostamente exato |

### Limite técnico relevante

**runReport** retorna agregados por dimensões e métricas; consultas simples com **eventCount** não garantem um funil sequencial de pessoas. Para funis estritamente encadeados por usuária/sessão, avaliar **runFunnelReport** (método v1alpha/early preview) e suas quotas/semântica antes de incluí-lo como dependência do MVP. Não misturar fontes com identidades ou janelas diferentes numa mesma taxa.

## 6. Deduplicação, navegação e privacidade

1. **Uma observação por ação efetiva:** não emitir no **render()**, atualizações por **pageshow**, **visibilitychange**, reconsulta da API, reentrada por polling ou disparos automáticos.
2. **Sugestão versus seleção manual:** a sugestão chama **opcao.click()** para efetivar o horário. Exigir mecanismo explícito de origem/guarda na instrumentação; emitir **booking_time_selected** uma única vez com **selection_source=suggestion**, além do evento distinto de preferência **booking_suggestion_selected**.
3. **Separar ator:** **origem=admin** e autenticação administradora devem impedir participação no funil de clientes. Atenção: **principal.html** é compartilhado por ambas as funções; page_view pode ocorrer antes da resolução da role. Planejar inicialização de GA4 condicionada à role ou filtro equivalente confiável.
4. **Dados privados:** não mandar payloads completos de API, textos, query string contendo **reagendar**, IDs financeiros, datas/horas exatas, e-mails ou nomes; higienizar **page_location**/**page_referrer** e campos automáticos da tag.
5. **Falha de rede/consentimento:** o sistema deve continuar perfeitamente funcional e não enfileirar retries que alterem o PIX.
6. **Conversão UI:** registrar sucesso de interface apenas na transição validada e limitar retries por operação. **Não** publicar conversão oficial pelo navegador como substituto da verdade do servidor.
7. **Tráfego de testes:** excluir ou segmentar DebugView, contas de QA e preview da Vercel nas análises de produção.

## 7. Matriz de testes proposta para a Fase 2

| Cenário | Resultado esperado |
| --- | --- |
| Cliente acessa agendamento com serviço válido | **booking_flow_started** uma vez, **new** |
| Serviço inexistente/inativo | Nenhum **booking_flow_started** bem-sucedido |
| Sugestões não aparecem | Nenhum **booking_suggestions_displayed** |
| Sugestão aparece e é escolhida validamente | Exposição + **booking_suggestion_selected** + um **booking_time_selected** com **suggestion** |
| Sugestão deixa de estar disponível na revalidação | Não emitir **booking_suggestion_selected** nem **booking_time_selected** |
| Grade aberta por toque | Um **booking_all_times_opened** por abertura real; nunca ao inicializar oculta |
| Escolha manual na grade | **booking_time_selected** com **full_list**, sem **booking_suggestion_selected** |
| Consulta PIX apresenta cotação, sem prosseguir | **booking_quote_viewed**, nenhum QR, nenhuma conversão |
| Reserva PIX/QR emitido, sem pagamento | **booking_pix_qr_shown**, nenhuma conversão confirmada |
| PIX pago confirmado enquanto o navegador está aberto | Um **booking_pix_confirmed_ui**; confirmado oficial contado pelo backend |
| PIX confirmado após a cliente fechar o app | Backend conta confirmação; GA4 pode não registrar sucesso visual |
| Cliente isenta confirma pelo endpoint | Um **booking_exempt_confirmed_ui** após resposta bem-sucedida |
| Reagendamento sem PIX/pago | **reschedule**, não aumenta total de novos agendamentos |
| Reagendamento PIX em sincronização pendente | Sem evento “concluído” antes de operação efetivamente concluída |
| Tela administrativa no mesmo dispositivo | Interações fora do funil de cliente |
| GA4 bloqueado, desconectado ou sem consentimento | Agendamento, consulta, PIX e Calendar seguem funcionando normalmente |
| Refresh/repetição de callback/polling | Nenhuma contagem múltipla por causa da rotina |
| Campos de serviço, observação e parâmetros de URL | Nenhuma informação pessoal nem id de agendamento enviada ao GA4 |

**Aceite da Fase 2:** validar eventos em DebugView (com valores anonimizados), confirmar cobertura de páginas e papéis, verificar que não há regressões nos testes de agenda/PIX/Calendar, e demonstrar que os indicadores não confundem intenção, QR e reserva confirmada.

## 8. Recomendações de execução incremental

- **Lote 2A:** carregar/regularizar GA4 somente nas telas de cliente necessárias; filtrar/excluir administradoras; corrigir **page_location**; validar consentimento e eventos básicos de serviço, data, sugestão, grade, horário e clique confirmar.
- **Lote 2B:** instrumentar PIX e isenção com marcos não financeiros corretos, categorização de falhas sem dados pessoais, e reagendamento como fluxo separado.
- **Lote 2C:** criar/validar dimensões e métricas GA4, DebugView e matriz real de cobertura. Não publicar dashboards de conversão até haver coleta representativa.
- **Fase 3:** conectar a Google Analytics Data API e endpoints de agregados oficiais sob autenticação administrativa. **Sem mudanças no esquema financeiro ou de agendamentos apenas para rastrear cliques.**
- **Fase 4:** apresentar painel web com legendas de fontes, filtros de período, eventuais limitações de amostragem/processamento e espaço para estados vazios (“ainda sem dados”).

### Documentação oficial

- [Eventos GA4](https://developers.google.com/analytics/devguides/collection/ga4/events)
- [Data API Core Reporting](https://developers.google.com/analytics/devguides/reporting/data/v1/)
- [API de funil (pré-lançamento)](https://developers.google.com/analytics/devguides/reporting/data/v1/funnels)
- [API Schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)
- [Política sobre dados identificáveis](https://developers.google.com/analytics/devguides/collection/protocol/ga4/policy)

**Esta especificação é proposta, não evidência de eventos já implantados.**
