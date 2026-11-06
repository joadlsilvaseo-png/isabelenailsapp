# Agendamentos consecutivos — mesma cliente

Esta alteração permite que uma cliente autenticada pelo Firebase reserve um segundo serviço **exatamente quando o anterior termina**, dispensando apenas o buffer entre os dois serviços da mesma titular.

- Cliente A: 16:00–17:00 e 17:00–19:00 → permitido, se não existirem outros conflitos.
- Cliente B tentando 17:00 depois de A 16:00–17:00 → bloqueado; somente a partir de 17:15.
- Cliente A tentando 17:05 após terminar às 17:00 → bloqueado (não é exatamente consecutivo e o buffer de 15 minutos não se completou).
- Sobreposição de serviços, bloqueios manuais, janelas do expediente e reservas de terceiros → nunca liberados.
- O cliente é identificado pelo UID do token Firebase validado pelo servidor, não pelo nome ou por parâmetro fornecido na URL.
- No frontend o Firestore marca os próprios agendamentos; o servidor marca reservas PIX do UID autenticado com `mesmaCliente: true`, sem divulgar identificadores de outras contas.
- A criação da reserva PIX é revalidada no PostgreSQL sob lock por data, além dos agendamentos Firestore. Reserva PIX continua com cobrança individual e confirmação independente.
- A criação de agendamento com isenção de sinal PIX também é contemplada, com validação do proprietário, bloqueio e Firestore.
- Reagendamentos de agendamentos existentes e alterações de serviço continuam com as regras anteriores; não foram modificados nesta primeira entrega.
- Sem migração SQL: a restrição GiST do PostgreSQL já permite intervalos adjacentes, mas proíbe sobreposições reais.
- Sem alteração do intervalo global de 15 minutos ou qualquer cálculo financeiro do Mercado Pago.

## Antes de publicar

Validar testes automatizados, simular duas reservas independentes para o mesmo UID em ambiente de teste e confirmar que UID diferente é rejeitado. Publicar a API na VPS antes do frontend. Após validar autenticação e disponibilidade, integrar a PR na main. **Não fazer deploy automaticamente a partir da branch.**
