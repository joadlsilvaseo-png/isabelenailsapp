# Análise Web da Isabele — Fase 1: auditoria e plano do MVP

**Projeto:** Isabele Mariana Nails  
**Data:** 17/11/2026  
**Base auditada:** main, commit `7524d65c15ce2e909666d7cca572189c61d81ad5`  
**Situação:** levantamento documental. **Nenhuma instrumentação, API, banco, interface ou configuração de produção alterados.**

> Objetivo: transformar o comportamento real de navegação e agendamento em indicadores acionáveis para a Isabele, mantendo a agenda, o sinal PIX e o Google Calendar como estão. Este relatório examina código, não demonstra recebimento real de eventos no GA4 nem acesso à propriedade Analytics.

## 1. Decisão de produto

O **Análise Web da Isabele** será um painel web de **inteligência comportamental** para a profissional, diferente do dashboard administrativo atual. O foco é saber o que as clientes procuram, como escolhem um horário, quanto usam as sugestões inteligentes, onde encontram obstáculos e quais caminhos chegam à confirmação.

**Fontes com papéis diferentes:**

1. **GA4:** visualizações, sessões/usuárias ativas, interações e eventos de interface, com dados agregados.
2. **Backend e Firestore/PostgreSQL:** estado efetivo e autoritativo das reservas, confirmações, cancelamentos e reagendamentos. Uma cobrança PIX gerada ou uma tela de sucesso aberta não são, isoladamente, prova de reserva confirmada.
3. **Painel de análise:** consulta GA4 via Google Analytics Data API no servidor e recebe agregados operacionais por endpoint administrativo de leitura; não realiza qualquer alteração em agendamentos.

**Princípio:** exibir separadamente o funil comportamental e os totais operacionais até haver uma estratégia validada de coorte/jornada que permita calcular conversão ponta a ponta sem misturar denominadores.

## 2. Achados confirmados no repositório

| Área | Evidência no código | Conclusão |
| --- | --- | --- |
| GA4 central | [analytics.js](../analytics.js) | Usa gtag.js com Measurement ID **G-ZFCQC4FFJS**, inicializa configuração e expõe **trackEvent**; o ID de medição NÃO é o Property ID numérico exigido pela Data API. |
| Login | [login.js](../login.js) | **trackEvent("login")** após autenticação por Google e por e-mail/senha. Não inclui, nesse evento, distinção de método. |
| Cadastro | [registro.js](../registro.js) | **trackEvent("registro")** no sucesso do cadastro por e-mail; eventos denominados **signup_attempt**, **signup_success** e **signup_error** são escritos pelo **logEvent local no console**, sem envio GA4 comprovado. O fluxo Google não chama **trackEvent("registro")**. |
| Galeria | [galeria.js](../galeria.js) | Registra **gallery_tab_switch**, **gallery_image_view**, **view_gallery**. |
| Permissão de push | [notificationService.js](../notificationService.js) | Registra **push_subscription_opt_in**. Não é parte do funil central. |
| Páginas com tag | [index.html](../index.html), [principal.html](../principal.html), [galeria.html](../galeria.html), [admin-agendamentos.html](../admin-agendamentos.html), [admin-servicos.html](../admin-servicos.html) | Têm **analytics.js** explicitamente na página. |
| Páginas sem tag direta | [agendamento.html](../agendamento.html), [confirmacao.html](../confirmacao.html), [categoria.html](../categoria.html), [meu-perfil.html](../meu-perfil.html), [dashboard.html](../dashboard.html), páginas de serviços específicas | O carregamento do GA4 não está implementado diretamente nesses HTMLs; **agendamento.js**, **pixCheckout.js** e **confirmacao.js** também não importam **trackEvent**. Login/cadastro importam o módulo via JS, embora seus HTMLs não o incluam diretamente. |
| Funil de horários | [agendamento.js](../agendamento.js), [agendamentoPainelHorarios.mjs](../agendamentoPainelHorarios.mjs), [agendamento.html](../agendamento.html) | Existem **Horários sugeridos** e controle **Ver todos os horários**; a seleção de uma sugestão passa pela validação real de disponibilidade antes de ativar o horário. Não há eventos GA4 específicos para essas escolhas. |
| Pagamento | [pixCheckout.js](../pixCheckout.js) | Um novo agendamento da cliente segue isenção ou cotação → reserva temporária → emissão PIX → consulta de confirmação. A cotação não reserva horário. Não se deve contar cotação nem QR como conversão. |
| Confirmação | [pixCheckout.js](../pixCheckout.js), [confirmacao.js](../confirmacao.js), [infra/backend/src/pixConfirmacaoFirestore.js](../infra/backend/src/pixConfirmacaoFirestore.js) | A confirmação PIX é validada no backend; a tela também pode aguardar/reconsultar. **Visualizar confirmacao.html não equivale necessariamente a confirmar um novo agendamento.** |
| Isenção | [infra/backend/src/agendamentosIsencaoPix.js](../infra/backend/src/agendamentosIsencaoPix.js) | Cria agendamento **confirmado** no Firestore no fluxo isento, com idempotência. |
| Reagendamento | [meu-perfil.js](../meu-perfil.js), [agendamento.js](../agendamento.js), [agendamentosApi.js](../agendamentosApi.js) | Caminho próprio com parâmetro **reagendar**; o fluxo de PIX pago envolve conclusão de operação pela API/worker. Não deve gerar um “novo agendamento” no funil de aquisição. |
| Dashboard operacional | [dashboard.js](../dashboard.js) | Já agrupa status, concluidos, cancelados e receita de atendimentos concluídos. Não equivale a um painel de comportamento GA4. |
| Acesso | [principal.js](../principal.js), [infra/backend/src/gestaoClientes.js](../infra/backend/src/gestaoClientes.js) | Há papel **admin** e verificação de **ativo**. O painel novo deverá revalidar permissões no backend, sem confiar em elementos ocultos do frontend. |
| Privacidade | [termos.html](../termos.html), seção “Política de Privacidade” | Texto existente prevê melhoria da experiência e uso de prestadores tecnológicos; **revisar transparência sobre Analytics, bases legais e configuração de consentimento** antes de ampliar a coleta. Esta auditoria não valida conformidade jurídica. |

**Atenção à qualidade histórica:** a presença de gtag.js no código não comprova que os eventos estejam chegando ao GA4, nem autoriza tratar páginas sem tag como cobertas. A coleta atual precisa ser confirmada em DebugView/Tempo real e na propriedade correta antes da Fase 2.

## 3. Mapa da jornada real

### 3.1 Descoberta e acesso

**index.html** → **login.html** ou **registro.html** → **principal.html**.  
Páginas de serviço via categorias: **categoria.html** e rotas específicas **unhas-em-gel.html**, **manicure.html**, **pedicure.html**. A pesquisa de serviços em [principal.js](../principal.js) pode levar diretamente a **agendamento.html?id=...**.

**Problema de medição:** etapas de catálogo e páginas operacionais não compartilham cobertura homogênea do GA4. O painel deve distinguir tráfego de clientes e administradoras; hoje a tag está também em telas de administração.

### 3.2 Escolha do atendimento

**agendamento.html** carrega o serviço, cria o calendário e mostra horários.  
A usuária pode selecionar uma data, tocar um **horário sugerido** ou abrir **Ver todos os horários** e selecionar manualmente. O componente de sugestões usa informações de agenda como proposta de interface, mas o horário sugerido só é assumido após consulta de disponibilidade e validação da seleção. Ao tocar numa sugestão, a rotina pode chamar programaticamente o clique do horário real: **não contar esse clique como segunda escolha manual**.

**Problema de medição:** falta identificar origem da seleção (sugestão versus grade completa), quantas sugestões foram efetivamente exibidas, aberturas da grade e disponibilidade/erros.

### 3.3 Confirmação de novo agendamento — cliente

**Caminho A: isenção de sinal**  
Clique válido em Confirmar → **GET /agendamentos/isencao** → **POST /agendamentos/sem-pix** → Firestore status confirmado → redirecionamento à confirmação.

**Caminho B: PIX**  
Clique válido em Confirmar → **POST /pix/cotacao** (leitura; nenhuma reserva) → confirmação de prosseguir → **POST /pix/reservar** (hold) → **POST /pix/emitir** (QR) → consulta **POST /pix/status** → backend confirma o agendamento após conciliação → interface mostra sucesso.

**Eventos distintos obrigatórios:** intenção, cotação, QR apresentado, confirmação visual. **Registro oficial de nova reserva confirmada vem do backend**, incluindo quem saiu do app antes de ver a tela final.

### 3.4 Reagendamento e administração

A cliente pode ir de **meu-perfil.html** a **agendamento.html?reagendar=...**. A profissional possui um fluxo administrativo próprio. A API diferencia alteração de agendamento existente de criação, inclusive com caminhos de sinal PIX pago. **Não misturar “reagendamentos concluídos” com novos agendamentos.**

## 4. Indicadores do MVP, com fonte e interpretação

| Indicador | Fonte | Definição/limite |
| --- | --- | --- |
| Usuárias ativas no período | GA4 **activeUsers** | Usuárias Analytics identificadas pelo GA4, **não** contagem exata de clientes cadastradas. Separar tráfego de administração. |
| Sessões e visualizações | GA4 **sessions**, **screenPageViews** | Sujeitas à cobertura de tags e configuração de coleta. |
| Acessos ao fluxo de agendamento | GA4 **booking_flow_started** | Disparo após serviço carregado com sucesso, discriminando tipo de fluxo e papel. |
| Sugestões exibidas / utilizadas | GA4 **booking_suggestions_displayed** e **booking_suggestion_selected** | Exibição elegível e seleção válida, não tentativa de clique inválida. Comparar sessões expostas e selecionadas após definição de deduplicação. |
| Abertura da grade completa | GA4 **booking_all_times_opened** | Somente abertura intencional do componente; não contar expansão programática. |
| Horários escolhidos | GA4 **booking_time_selected** | Seleção válida. Parâmetro **selection_source** distingue sugestão/grade sem emitir eventos duplicados. |
| Inícios de checkout PIX | GA4 **booking_quote_viewed**, **booking_pix_qr_shown** | Cotação e QR não significam pagamento nem reserva concluída. |
| Confirmados por caminho | Backend (Firestore/PG) | Contar **novas reservas confirmadas**, separando PIX pago/isento, com regra temporal e deduplicação por agendamento. Não usar número de telas visitadas. |
| Cancelamentos e reagendamentos | Backend | Exibir contagens separadas, sem falsear agendamentos novos; definir status final versus transição histórica. |
| Queda entre passos | GA4 | Inicialmente **funil de eventos ou sessões do GA4**. Não dividir cegamente confirmados do backend por usuários do GA4 e chamar de taxa exata de conversão. |
| Tempo para selecionar horário | Evento de duração anonimizado no frontend | Medir somente o intervalo entre entrada válida e seleção, evitar contagem de períodos em background. Não confundir com tempo de pagamento. |
| Serviços/categorias procurados | GA4 por categoria | Apenas categorias e valores não pessoais; sem busca digitada, nome, e-mail ou dados de reserva. |

**Períodos previstos:** 7, 30 e 90 dias e intervalo personalizado, com indicação de **America/Sao_Paulo**, datas inclusivas documentadas e eventual atraso de processamento do GA4. Em gráficos comparativos, explicitar períodos de cobertura diferentes.

**O que não prometer no MVP:** “quantas clientes únicas efetivamente converteram” por junção GA4–Firestore sem modelo de identidade/coorte aprovado; renda PIX a partir de eventos de navegação; abandono individual nominal; previsão de desistência individual.

## 5. Proposta do painel web

1. **Visão geral:** usuárias ativas, sessões, acessos ao agendamento, agendamentos confirmados do backend, comparação de períodos e origem de cada número.
2. **Funil de agendamento:** serviço → data/horário → confirmar → cotação/isenção → QR → confirmação observada. Etiquetas visuais distinguem **passos medidos pelo GA4** de **reservas confirmadas oficialmente**.
3. **Sugestões inteligentes:** exposições, escolhas efetivas, uso da grade completa, diferenças por turno e categoria.
4. **Pontos de atrito:** sem horários, falhas de disponibilidade, erros de validação e desistência aproximada por etapa, sem dados pessoais.
5. **Filtros:** período, tipo de fluxo (novo/reagendamento), origem (sugestão/grade), categoria e papel permitido.

O layout será responsivo, com leitura confortável no desktop e tablet. Os dados do GA4 virão do backend com autenticação; **nenhum token ou credencial de API será exposto na interface**.

## 6. Arquitetura sugerida, sem implementação nesta fase

    PWA cliente ── eventos anônimos e permitidos ──> GA4
                                                        |
                                                        | Data API: relatórios
                                                        v
    Painel web autenticado ──> API Node.js na VPS ──> agregados
                                      |
                                      +── Firestore/PostgreSQL
                                          (contagem oficial de reservas)

- **Frontend:** aplicação/páginas separadas do fluxo de agendamento, usando o padrão de UI atual.
- **Autenticação:** Firebase Auth; backend verifica token e perfil **usuarios.role=admin** e **ativo=true**; autorização de leitura em cada rota.
- **GA4:** obter **Property ID numérico**, definir acesso de leitura à propriedade para identidade de serviço apropriada, permitir somente consultas de relatório aprovadas; métricas/dimensões via **runReport**. Funil de coorte mais rigoroso pode usar **runFunnelReport** (pré-lançamento) após validação de disponibilidade, quotas e semântica.
- **Performance:** cache de agregados por período com TTL moderado e datas de atualização; nenhum endpoint faz leitura integral de coleções para toda atualização da tela.
- **Segurança:** não expor dados pessoais brutos de clientes no painel de comportamento; retornar somente indicadores agregados.
- **Release da VPS:** a imagem ativa foi publicada anteriormente como derivação isolada da versão **cf9a4d** com patch de notificações PR #68. Ao chegar à Fase 3, inventariar o container e os Compose reais, preservar OAuth/PIX/lembretes, validar o delta, fazer backup e implantar de modo controlado; **não presumir que um checkout da main equivale à imagem ativa**.

## 7. Privacidade e governança

- Nunca enviar ao GA4: nome, e-mail, telefone, CPF, observações, texto de pesquisa, identificadores internos de agendamento, IDs financeiros, token Firebase, URL com parâmetros sensíveis, nem dados de login/PIX.
- **Não enviar automaticamente o UID Firebase como dimensão personalizada.** Se identificação analítica for necessária no futuro, haverá revisão específica de finalidade e política de User-ID.
- Enviar somente parâmetros de baixa cardinalidade, por exemplo **flow_type**, **actor_role**, **selection_source**, **service_category**, **payment_path** e **time_bucket**.
- Revisar URLs coletadas pelo **page_view**: especialmente parâmetros de reagendamento e demais identificadores em query strings.
- Rever transparência de privacidade/consentimento e funcionamento do Analytics antes de ampliar a coleta. Confirmar exigências com responsável pela privacidade.
- Não acrescentar scripts/SDKs que interrompam renderização ou operações financeiras. Falhas de GA4 devem ser silenciosas para o agendamento.

Referências oficiais consultadas:  
- [GA4: configurar eventos](https://developers.google.com/analytics/devguides/collection/ga4/events)
- [GA4: eventos recomendados](https://developers.google.com/analytics/devguides/collection/ga4/reference/recommended-events)
- [Google Analytics Data API](https://developers.google.com/analytics/devguides/reporting/data/v1/)
- [Google: política de dados identificáveis](https://developers.google.com/analytics/devguides/collection/protocol/ga4/policy)
- [GA4: dimensões e métricas de relatório](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema)

## 8. Pendências antes da Fase 2

**A confirmar com acesso legítimo à propriedade Analytics (não inferir pelo código):**

- Property ID numérico e permissão de leitura, vinculação correta à medição **G-ZFCQC4FFJS**.
- Se eventos **login**, **registro** e **gallery_*** realmente aparecem em DebugView e nos relatórios.
- Domínios/ambientes coletados, filtros de tráfego interno e de desenvolvimento, histórico disponível, consentimento e limitações atuais.
- Se a medição automática de page_view inclui parâmetros sensíveis e visitas administrativas.
- Regras de deduplicação e escopo para eventCount versus sessões/usuárias antes de denominar um percentual “conversão”.
- Revisão de política de privacidade e de parâmetros destinados à mensuração.

## 9. Critérios de aceite desta fase

- [x] Inventário das chamadas GA4 no código e distinção de logs locais.
- [x] Cobertura por páginas e pontos não instrumentados.
- [x] Jornada novo agendamento (PIX e isento), sugestão, grade e reagendamento documentados.
- [x] Fontes e limites de cada KPI explicitados.
- [x] Arquitetura segura e MVP definidos.
- [x] Contrato proposto de eventos em [analise-web-isabele-eventos-v1.md](./analise-web-isabele-eventos-v1.md).
- [ ] Auditoria real dos dados/credenciais da propriedade GA4 — **não realizada nesta fase sem acesso autorizado**.
- [ ] Aprovação para instrumentar o app — **depende da Fase 2**.

**Próxima etapa, somente após aprovação:** instrumentar eventos prioritários em ambiente controlado, testar na interface e DebugView, verificar a privacidade e publicar frontend de forma incremental. Nenhum deploy de VPS nesta fase.
