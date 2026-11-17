# Análise Web da Isabele — Fase 2C | Validação de coleta e dimensões no GA4

**Projeto:** Isabele Mariana Nails · **Data:** 17/11/2026  
**Referências:** [Auditoria Fase 1](./analise-web-isabele-fase1.md) · [Contrato de eventos](./analise-web-isabele-eventos-v1.md) · [Implementação Fase 2B](./analise-web-isabele-fase2b.md)

> **Estado de execução:** instrumentação 2A/2B verificada pelo repositório e testes; **NÃO temos acesso autenticado à propriedade GA4 nesta etapa.** Este documento prepara a validação real e indica os critérios de aceite, mas **não afirma que os eventos chegaram ao Analytics**, que as dimensões foram criadas ou que o DebugView foi aprovado.

## 1. Inventário confirmado no código

- **Measurement ID da tag:** `G-ZFCQC4FFJS` — em `analytics.js`. Não é o **ID numérico da propriedade GA4**, necessário na Data API.
- **Rastreio:** `bookingAnalytics.mjs`, ligado a `agendamento.js` e `pixCheckout.js`; a mesma instância filtra perfil e diferencia `flow_type=new/reschedule`.
- **Emissão:** `analytics.js` usa `gtag("event", ...)`; com `agendamento.html`, a tag só é carregada após autorização do perfil; `page_location` do agendamento fica sem parâmetros de query.
- **Exclusões:** a nova coleta não deve registrar `role=admin`, identificadores, nome/telefone, observações, valores financeiros nem data/hora exatas.
- **Eventos de UI não são transações:** `booking_pix_qr_shown` NÃO é PIX pago, `booking_pix_confirmed_ui` é observação de resposta do backend; a verdade de agendamentos confirmados é o Firestore/PostgreSQL.
- **Limitações:** eventos enviados imediatamente antes de redirecionamento podem não alcançar o GA4, e bloqueadores ou falta de permissão impedem coleta. A coleta histórica não deve ser tratada como completa.

## 2. Os 12 eventos a verificar (GA4)

| Tipo | Evento | Ação para observar | Resultado permitido |
| --- | --- | --- | --- |
| Navegação | `booking_flow_started` | Abrir agendamento de serviço válido, cliente ativa | `new` ou `reschedule` |
| Navegação | `booking_date_selected` | Escolher um dia válido | Sem data ISO enviada |
| Sugestões | `booking_suggestions_displayed` | Lista com opções é exibida | Uma emissão por carregamento da página |
| Sugestões | `booking_suggestion_selected` | Selecionar sugestão revalidada | Não emitir para sugestão rejeitada |
| Grade | `booking_all_times_opened` | Clicar em “Ver todos os horários” | Não contar abertura programática |
| Grade | `booking_time_selected` | Escolher um horário | `selection_source=suggestion/full_list`; `time_bucket` |
| Intenção | `booking_submit_clicked` | Tocar Confirmar com dados válidos | Não é conversão financeira |
| PIX | `booking_quote_viewed` | Exibir cotação lida de `/pix/cotacao` | Sem reserva criada |
| PIX | `booking_pix_qr_shown` | QR/copia-e-cola efetivamente exibido | `payment_path=pix`, sem pagamento presumido |
| PIX | `booking_pix_confirmed_ui` | API `/pix/status` informou `agendamentoConfirmado=true` | Não enviar se apenas PIX creditado/pendente |
| Isenção | `booking_exempt_confirmed_ui` | `/agendamentos/sem-pix` confirmou a reserva | `payment_path=exempt` |
| Reagendamento | `booking_reschedule_completed_ui` | API/worker concluiu alteração | `flow_type=reschedule`; não emitir em sincronização pendente |

**Nenhum evento acima é automaticamente um “evento principal” (key event).** Antes de definir conversões na propriedade, verificar a semântica: QR, cotação e clique não são resultados financeiros.

## 3. Dimensões personalizadas a criar na propriedade

No Google Analytics: **Administrador → Exibição de dados → Definições personalizadas → Criar dimensão personalizada** (nomes de menu podem variar).

Para cada linha, escolher **escopo Evento** e informar exatamente o parâmetro indicado. Criar uma dimensão por parâmetro, não uma por evento:

| Nome sugerido no GA4 | Escopo | Parâmetro de evento | Exemplos |
| --- | --- | --- | --- |
| Tipo de agendamento | Evento | `flow_type` | `new`, `reschedule` |
| Categoria de serviço | Evento | `service_category` | `manicure`, `pedicure`, `unhas-em-gel`, `unknown` |
| Origem do horário | Evento | `selection_source` | `suggestion`, `full_list` |
| Caminho de confirmação | Evento | `payment_path` | `pix`, `exempt` |
| Turno escolhido | Evento | `time_bucket` | `morning`, `afternoon`, `evening` |
| Perfil de acesso (opcional, útil para QA) | Evento | `actor_role` | Deve ser `client` neste funil |

**Não criar uma dimensão para `eventName`**: ela já existe nativamente. `analytics_schema_version=1` é um controle técnico, não uma dimensão obrigatória do MVP.

Requisitos: usuário **Editor ou Administrador** na propriedade para criar definições. Pode levar **24–48 horas após criação e envio** dos dados para as dimensões aparecerem nos relatórios. Não são uma forma de reconstruir parâmetros anteriores não configurados. Fonte: <https://support.google.com/analytics/answer/14239696?hl=pt-BR>.

Na Data API, consultar dimensões evento personalizadas com os nomes `customEvent:flow_type`, `customEvent:service_category`, `customEvent:selection_source`, `customEvent:payment_path`, `customEvent:time_bucket` e `customEvent:actor_role` (se esta última for registrada). O relatório `eventName` e a métrica `eventCount` são nativos. Ver <https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema>.

## 4. Passo a passo da validação real — sem impactar agendamentos

### 4.1 Conferir a propriedade correta

1. Abrir <https://analytics.google.com/> com a conta que administra a propriedade da Isabele.
2. Confirmar o **ID da propriedade (numérico)** e o fluxo Web com `G-ZFCQC4FFJS`.
3. Conferir **fuso horário** da propriedade, idealmente `America/Sao_Paulo`, e a configuração de filtragem de tráfego interno, testes e domínio.
4. Conferir se existe coleta real de navegação normal e quais eventos legados estão chegando. Não inferir de `window.dataLayer`.

**Não colocar credenciais, tokens de conta ou chaves de serviço em comandos de console ou commits GitHub.**

### 4.2 Validar no Tag Assistant e DebugView

1. No computador, abrir <https://tagassistant.google.com/> com o app da Isabele numa aba separada e **habilitar a depuração** para essa sessão.
2. Acessar **Admin → DebugView** na propriedade GA4 e escolher o dispositivo de depuração.
3. Entrar com conta de cliente de teste **autorizada**, em **ambiente seguro**; navegar até um serviço e abrir o agendamento.
4. Executar apenas os passos não financeiros: exibição de sugestões, seleção de um horário disponível, abertura da grade, seleção de outro horário.
5. Observar `booking_flow_started`, `booking_suggestions_displayed`, `booking_suggestion_selected`, `booking_all_times_opened`, `booking_date_selected` e `booking_time_selected`.
6. Conferir os parâmetros do evento (não apenas o nome): `flow_type`, `actor_role`, `service_category`, `selection_source`, `time_bucket`. Garantir que nenhum ID de reserva ou dado pessoal foi enviado.
7. **Opcional de baixo risco:** o primeiro clique de confirmar consulta isenção e, se não isenta, solicita somente cotação; **não** prosseguir para emissão PIX durante QA em produção. Confirmar `booking_submit_clicked` e, quando aplicável, `booking_quote_viewed`.
8. Os eventos `booking_pix_qr_shown`, `booking_pix_confirmed_ui`, `booking_exempt_confirmed_ui` e `booking_reschedule_completed_ui` exigem operações reais e devem ser validados com casos autorizados ou infraestrutura/sandbox controlados. **Não fabricar reservas, pagamentos ou cancelamentos reais para testar Analytics.**
9. Testar acesso da administradora em agendamento: a nova instrumentação **não deve** produzir eventos `booking_*`.
10. Conferir o painel **Tempo real**, depois os relatórios processados. Desativar a depuração ao fim.

Guias oficiais: <https://support.google.com/analytics/answer/7201382?hl=pt-BR> e <https://support.google.com/analytics/answer/9333790?hl=en>.

### 4.3 Auditoria local somente de leitura

O arquivo [`scripts/ga4-2c-auditoria-console.js`](../scripts/ga4-2c-auditoria-console.js) é um **snippet local para DevTools**, não um recurso carregado automaticamente pelo aplicativo.

1. No Chrome, abrir **F12 → Sources → Snippets** (ou área equivalente em ferramentas do navegador).
2. Criar um snippet chamado `auditoria-isabele-2c`, copiar o conteúdo do arquivo acima e executar **na aba do agendamento**.
3. O script mostra apenas **12 nomes, contagens, índices e códigos de alerta**, jamais os payloads ou dados pessoais.
4. Para repetir após outras interações, executar `window.__isabeleGA4Auditoria()`. Os resultados só refletem eventos registrados na dataLayer **da aba atual**.
5. “Não observado” **não equivale a falha**: muitas etapas só são registradas após ações específicas. Eventos de pagamento/reagendamento não devem ser forçados em produção.
6. A dataLayer pode conter comandos `gtag('event', ...)` ainda não entregues; este snippet **não substitui** o DebugView e inspeção de rede.

**Não compartilhar dumps da `dataLayer` completa**: eventos de outras integrações podem conter informações pessoais. O snippet limita a exibição a agregados seguros.

## 5. Relatórios a validar após cadastro

**No GA4 — Explorar → Forma livre**, ou na Data API futura:

- Filtrar `eventName` pelos eventos `booking_*`; cruzar por `flow_type` e `service_category`.
- Comparar **`booking_suggestions_displayed`** versus **`booking_suggestion_selected`**, como **contagens de eventos**, não proporção de pessoas.
- Comparar **`booking_all_times_opened`** e **`booking_time_selected`** com `selection_source`, sem presumir que abriu grade = agendou.
- Medir etapas do PIX: `booking_submit_clicked` → `booking_quote_viewed` → `booking_pix_qr_shown` → `booking_pix_confirmed_ui`; isenção deve ser uma ramificação separada.
- Separar `booking_reschedule_completed_ui` por `flow_type=reschedule`, nunca somar aos novos confirmados.
- Etiquetar os totais como **eventos observados no GA4**; total oficial de atendimentos permanece no backend.
- Para taxas sequenciais de pessoas/sessões, usar instrumento de funil que preserve ordem e unidade de análise. **Não chamar a divisão de duas contagens de eventos de taxa de conversão por cliente.**

Exemplo de **corpo hipotético** de relatório Data API para validar os nomes da Fase 3, após registrar dimensões:

```json
{
  "dateRanges": [{ "startDate": "7daysAgo", "endDate": "yesterday" }],
  "dimensions": [{ "name": "eventName" }, { "name": "customEvent:flow_type" }],
  "metrics": [{ "name": "eventCount" }],
  "dimensionFilter": {
    "filter": {
      "fieldName": "eventName",
      "stringFilter": { "matchType": "BEGINS_WITH", "value": "booking_" }
    }
  }
}
```

Endpoint futuro: `POST /v1beta/properties/{GA_PROPERTY_ID}:runReport`. Não executar na interface pública; a API deve ser chamada com credenciais seguras no backend, somente leitura e protegida por autenticação administrativa.

## 6. Critérios de aceite

| Critério | Estado nesta entrega |
| --- | --- |
| Auditar os 12 nomes registrados no código 2A/2B | **Executável por testes automatizados** |
| Validar tipos/valores de parâmetros e vazamento óbvio no dataLayer | **Auditor local e testes incluídos** |
| Conferir ausência de eventos em administradora | **Testes de unidade existentes; teste real pendente** |
| Confirmar 12 eventos recebidos no GA4 | **Pendente: exige propriedade/sessões de teste** |
| Criar seis dimensões evento (cinco prioritárias + uma opcional) | **Pendente: acesso Editor/Admin à propriedade** |
| Verificar DebugView, Tempo real, comportamento de consentimento e domínios | **Pendente: validação no GA4** |
| Confirmar diferenças nos relatórios com 24–48h de processamento | **Pendente: dados reais** |
| Garantir ausência de regressão em agendamentos/PIX/Calendar | **CI e casos de segurança; QA real ainda recomendado** |

**Não considerar a Fase 2C aprovada em produção até os critérios externos serem realizados.** A PR técnica aqui é exclusivamente preparatória (auditoria, testes e documentação), sem novos eventos nem deploy na VPS.
