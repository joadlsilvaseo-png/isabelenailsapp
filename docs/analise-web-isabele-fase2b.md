# Análise Web da Isabele — Fase 2B: marcos de checkout e confirmação

**Escopo:** apenas eventos comportamentais GA4 (frontend), sobre a [Fase 2A](./analise-web-isabele-eventos-v1.md).  
**Implementação:** `bookingAnalytics.mjs` (fonte única dos eventos), `agendamento.js` (rastreamento autorizado, reagendamento) e `pixCheckout.js` (novos agendamentos).  
**Não altera:** API, PostgreSQL, Firestore, estados financeiros, taxas, PIX, sincronização Calendar, disponibilidade e ações de agendamento.

## Eventos emitidos

| Evento | Gatilho comprovável no frontend | Interpretação |
| --- | --- | --- |
| `booking_submit_clicked` | Clique válido no botão de confirmar: novo agendamento passa por `selecionarDados`; reagendamento passa por `validarAgendamento` e dados básicos. Não é confirmação | **Intenção** de avançar |
| `booking_quote_viewed` | `/pix/cotacao` retorna valores coerentes, a cotação é apresentada | **Leitura de preço**, sem reserva |
| `booking_pix_qr_shown` | `mostrarPedido` recebeu QR ou copia-e-cola válido e exibiu painel | **PIX criado/exibido**, sem confirmação de pagamento |
| `booking_pix_confirmed_ui` | `/pix/status` retornou `agendamentoConfirmado === true` e `concluirAgendamento` foi chamado | **Confirmação observada pela UI**; não substitui registro oficial |
| `booking_exempt_confirmed_ui` | `/agendamentos/sem-pix` respondeu com `agendamentoId` após sucesso e a UI continua para a confirmação | **Isenção confirmada observada pela UI** |
| `booking_reschedule_completed_ui` | Reagendamento existente concluiu segundo API/worker: estado `concluida` para PIX pago, ou Calendar `confirmada`/`sem_alteracao` no caminho direto. Nunca no retorno `pendente` | **Reagendamento**, não novo agendamento |

## Como a segurança foi preservada

- O checkout usa uma ponte local `emitirMarcoCheckout` para a **mesma instância** do rastreamento criado na agenda. A implementação não carrega GA4 por conta própria e só envia se a autorização do perfil na Fase 2A tiver sido concedida.
- A fonte de autorização é o Firestore: `usuarios.role=cliente` e `ativo=true`, com compatibilidade para clientes legadas. Profissional/admin não contribui ao funil.
- Parâmetros em GA4: `flow_type`, `actor_role=client`, `service_category` (lista controlada), `analytics_schema_version=1` e `payment_path` somente para PIX/isenta. **Não enviar data/hora exatas, identificadores de reservas, UUIDs, valores financeiros, nomes, telefone, texto livre ou payloads da API.**
- Referências temporárias dos atendimentos são usadas exclusivamente para deduplicar eventos na memória e **não fazem parte do payload**. Atualizações por polling e reprocessamentos não criam evento extra de sucesso.
- `booking_pix_confirmed_ui` depende da API ter confirmado o agendamento; **não** é produzido pela cotação, QR, `pagamentoCreditado` ou pelo redirect.
- Evento de reagendamento é omitido em estados pendentes/indeterminados; a interface existente conserva sua semântica e redirects.
- Em caso de bloqueio do GA4 ou falha de carregamento da tag, não interferir no PIX nem retardar confirmações.
- Eventos são **best-effort** e não necessariamente entregues quando a página é fechada/redirecionada rapidamente. A fonte oficial de confirmações permanece Firestore/PostgreSQL; a Fase 3 deverá buscar agregados operacionais protegidos.

## Matriz de validação no Preview Vercel (antes de tratar o GA4 como fonte confiável)

1. Cliente normal: serviço válido, horário válido, botão Confirmar → `booking_submit_clicked`. Data/horário inválido não registra intenção.
2. Cotação PIX validada e exibida → `booking_quote_viewed`, sem QR nem confirmação se abandonar.
3. Prosseguir, reservar e emitir QR/copia-e-cola → `booking_pix_qr_shown`, mas **não** `booking_pix_confirmed_ui`.
4. PIX gerado e expirado/aguardando/revisão financeira → não registrar confirmação.
5. PIX aprovado com `agendamentoConfirmado=true` → um `booking_pix_confirmed_ui` por reserva, sem duplicar no polling.
6. Cliente isenta: backend confirma → `booking_exempt_confirmed_ui`, sem `booking_quote_viewed`.
7. Reagendamento PIX pago pendente e depois concluído → registrar apenas ao estado concluído; transição “pendente” não pode emitir sucesso.
8. Reagendamento sem PIX com Calendar direto confirmado → `booking_reschedule_completed_ui`. Se sincronização pendente → nenhum evento concluído.
9. Acesso administrativo e conta não autorizada → nenhum dos eventos novos.
10. Testar com bloqueador do GA4 → rotina financeira e Calendar continuam operacionais.
11. Validar os seis nomes no GA4 DebugView/Tag Assistant e `window.dataLayer` com uma cliente real **sem utilizar pagamentos de teste em produção**.

### Comando somente de inspeção de eventos no console da página

```js
console.table((window.dataLayer || [])
  .filter(e => e[0] === "event" && String(e[1]).startsWith("booking_"))
  .map(e => ({ evento: e[1], ...e[2] })));
```

**Lembrete:** a presença no `dataLayer` não comprova recebimento no GA4. A Fase 2C deverá comprovar recebimento e configurar dimensões personalizadas, com atenção à privacidade e ao tráfego interno. O painel agregará fontes, não identificará individualmente clientes.
