# Preparação para ativar PIX de produção

O código mantém `PIX_PRODUCTION_ORDERS_ENABLED=false` por padrão. O backend também recusa operações de produção sem token privado e segredo de webhook de produção. A branch não contém credenciais.

## Configuração futura

Obtenha no painel do Mercado Pago da aplicação de produção:

- `MP_ACCESS_TOKEN_PRODUCTION`: credencial privada de produção.
- `MP_WEBHOOK_SECRET_PRODUCTION`: segredo da assinatura do webhook de produção.

Cadastre esses valores em arquivo de ambiente fora do repositório e acessível somente ao serviço/administrador do servidor (por exemplo, arquivo de segredos com permissão `0600`). Nunca os coloque no frontend, em commits, logs ou mensagens. Mantenha separados `MP_ACCESS_TOKEN_TEST` e `MP_WEBHOOK_SECRET_TEST`.

Antes de ativar produção, confirme também no painel que a aplicação está habilitada para produção, que a conta tem uma chave PIX cadastrada e que a URL HTTPS do webhook recebe eventos **Orders**. A disponibilidade depende da conta e não é verificável a partir deste repositório.

## Ordem de liberação

1. Revisar e aplicar a migração `010_pix_webhook_ambientes.sql` em janela controlada; ela preserva os eventos existentes como ambiente `test` e muda a chave da fila para ambiente + Order. Não foi executada por este trabalho.
2. Fazer deploy da branch revisada mantendo `PIX_PRODUCTION_ORDERS_ENABLED=false`.
3. Validar webhook, fila, notificações, painel e recuperação com credenciais e pedidos de teste, usando os mocks locais como complemento.
4. Configurar token e segredo de produção no armazenamento protegido e registrar/configurar a URL HTTPS e eventos Orders no painel Mercado Pago.
5. Revisar com a responsável a migração, o monitoramento e o rollback; só então ativar `MP_ENVIRONMENT=production`, `PIX_WEBHOOK_ENABLED=true`, `PIX_WEBHOOK_WORKER_ENABLED=true` e `PIX_PRODUCTION_ORDERS_ENABLED=true`.
6. Fazer o teste real controlado de baixo valor aprovado pela responsável, conferindo o valor no Mercado Pago, PostgreSQL, Firestore, notificações e agenda antes de ampliar o uso.

O webhook só aceita uma assinatura que corresponda a exatamente um segredo e grava o ambiente identificado. A fila consulta a Order pela credencial desse ambiente; o corpo da notificação nunca é usado como comprovante de pagamento. O polling autenticado continua como recuperação.

## Reversão

Desative imediatamente `PIX_PRODUCTION_ORDERS_ENABLED`, `PIX_WEBHOOK_ENABLED` e `PIX_WEBHOOK_WORKER_ENABLED` para bloquear novas operações/processamento de webhook; preserve a fila e o histórico financeiro para análise. Não reverta apagando cobranças ou documentos confirmados. A restauração de versão deve manter o volume PostgreSQL e respeitar a migração 010 já aplicada.

## Dependências externas

- A aprovação do PIX e o processamento automático dependem de URL HTTPS pública, segredo correto, eventos Orders ativos e credencial do mesmo ambiente.
- A entrega de eventos ao Google Calendar continua dependendo do Apps Script externo aceitar o contrato atual e tratar o `eventId` estável como chave idempotente. O código externo não foi inspecionado nem validado neste trabalho; novas tentativas podem duplicar eventos se ele não reutilizar esse identificador.
