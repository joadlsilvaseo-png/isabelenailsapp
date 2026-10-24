# Implantação dos lembretes de agendamento

Esta mudança adiciona lembretes de 24 horas e 1 hora à API. A branch e esta PR não foram implantadas na VPS.

## Antes de implantar

1. Revisar e integrar a PR na `main`.
2. Confirmar que a VPS usa o checkout e o Compose descritos em `README-atualizacao-vps-pix.md`.
3. Conferir no Compose efetivo que `FIREBASE_WATCH_ENABLED` e `PUSH_WORKER_ENABLED` já estão habilitados. O procedimento preserva seus valores e não os ativa por conta própria. Se qualquer um estiver desabilitado, interromper e tratar isso como uma mudança operacional separada.
4. Confirmar que credenciais Firebase Admin e chaves Web Push VAPID já existem no serviço. Esta mudança não cria nem troca segredos.

## Aplicação

Use o script controlado `infra/scripts/atualizar-vps-pix.sh` e siga as etapas de transferência, execução, healthcheck e rollback de `README-atualizacao-vps-pix.md`. Para publicar a `main`, passe `BRANCH=main` ao iniciar o script. O script agora:

- verifica antes de parar a API se a migração 019 está pendente, aplicada ou parcial;
- aborta sem parar a API se encontrar estrutura parcial ou se `push_entregas` estiver ausente;
- gera o dump PostgreSQL protegido antes de aplicar a migração;
- aplica `019_lembretes_agendamento.sql` com `ON_ERROR_STOP` e só então inicia a API da revisão selecionada;
- preserva Compose, variáveis, credenciais, volumes, rede e flags financeiras;
- mantém a migração 019 no rollback. Ela só acrescenta colunas anuláveis e índice; não altera registros existentes.

Não execute SQL manualmente na produção nem aplique esta branch antes da revisão e integração da PR.

## Verificação pós-implantação

- Confirmar que a API está saudável e que os logs mostram `AgendaMonitor` e `PushWorker` iniciados.
- Conferir no PostgreSQL a existência de `push_entregas.agendado_para`, `push_entregas.agendamento_versao` e `idx_push_entregas_lembretes_pendentes`.
- Em ambiente de teste, criar um agendamento futuro e verificar as duas linhas com `tipo` `lembrete_24h` e `lembrete_1h`, `agendado_para` correto e o mesmo `destinatario_uid` da cliente.
- Reagendar ou cancelar o registro de teste e confirmar que as entregas ainda pendentes ficam em `estado='cancelado'` e não são selecionadas pelo worker.
- Confirmar que lembretes futuros não aparecem em `/notificacoes` antes de `agendado_para`.
- Confirmar entrega apenas em um dispositivo da cliente que tenha uma assinatura Web Push válida; a ausência de assinatura encerra a entrega como `sem_dispositivo` sem retry infinito.

Os testes automatizados locais não acessam a VPS, Firebase, Google Calendar ou serviços Push. Não faça agendamentos de teste em produção para validar o prazo de 24 horas.
