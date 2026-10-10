# Atualizacao incremental da VPS (PIX)

Este procedimento atualiza somente o servico `api` para o commit atual de `codex/correcao-pix-20261010`. O script deve ser transferido e executado manualmente por quem administra a VPS. Ele nao faz deploy ao ser adicionado ao repositorio.

## Antes de iniciar

- Confirme acesso SSH e espaco livre para um dump PostgreSQL, um release Git isolado e a imagem Docker nova.
- Confirme que `/opt/isabele` aponta para o checkout do projeto e que o `origin` e `joadlsilvaseo-png/isabelenailsapp`.
- O script exige Docker Compose v2, Git, `flock`, `curl`, Python 3 e `pg_dump` instalado dentro do container PostgreSQL.
- Identifique o arquivo Compose e o `.env` realmente usados em producao. O padrão e `/opt/isabele/infra/compose.yaml`; se forem diferentes, passe `COMPOSE_FILE` e `ENV_FILE` explicitamente.
- As variaveis de teste devem estar no ambiente efetivo do Compose. O script nunca imprime os valores. Produção será fixada como desativada (`MP_ENVIRONMENT=test` e `PIX_PRODUCTION_ORDERS_ENABLED=false`).
- Se o token de teste estiver presente, o PIX de teste fica habilitado no novo backend. Webhook e worker de teste so ficam habilitados quando token e segredo de webhook de teste estiverem presentes. O backend ainda precisa estar acessivel pelo callback configurado no Mercado Pago.

## Transferir e iniciar em segundo plano

No computador que tem o clone da branch, transfira apenas o script versionado. Troque `usuario@host-vps` pelo destino SSH correto:

```bash
scp infra/scripts/atualizar-vps-pix.sh usuario@host-vps:/tmp/atualizar-vps-pix.sh
```

Na VPS, instale o arquivo e inicie o modo em segundo plano. Execute como `root` ou com `sudo`; ajuste caminhos somente se a instalacao usar outros locais:

```bash
sudo install -o root -g root -m 0750 /tmp/atualizar-vps-pix.sh /usr/local/sbin/atualizar-vps-pix
sudo env APP_DIR=/opt/isabele bash /usr/local/sbin/atualizar-vps-pix start
```

O comando informa o PID e o caminho do log persistente, por padrão em `/var/log/isabele-deploy/pix-update-<UTC>.log`. Acompanhe esse caminho com `sudo tail -f <caminho-do-log>`. Para uma instalação fora dos padrões:

```bash
sudo env APP_DIR=/opt/isabele COMPOSE_FILE=/caminho/compose.yaml ENV_FILE=/caminho/.env bash /usr/local/sbin/atualizar-vps-pix start
```

O script busca a branch no GitHub, cria um worktree de release separado e não faz checkout, reset, stash ou limpeza no diretório atual. Antes de parar a API, salva `git status`, diff, arquivos não rastreados, cópia do Compose, ID da imagem anterior e dump PostgreSQL em `/opt/isabele-backups`. Arquivos ignorados e alterações locais permanecem no checkout original, que não é sobrescrito.

## O que a atualização executa

1. Confere o repositório remoto e resolve o commit mais recente da branch.
2. Gera o backup PostgreSQL em formato customizado antes de parar a API ou alterar o schema.
3. Constrói a nova imagem usando o código do release isolado.
4. Para somente o serviço `api`, aplica `infra/migrations/010_pix_webhook_ambientes.sql` com `ON_ERROR_STOP` e inicia o novo backend.
5. Fixa o modo Mercado Pago como teste e desativa a criação de pedidos de produção.
6. Aguarda até 60 segundos pelo endpoint `/health` (status da API e conexão PostgreSQL) e registra a contagem por ambiente da fila de webhooks.

O script não cria pedidos, não realiza pagamentos, não chama Google Apps Script, não executa migrações anteriores e não reinicia o PostgreSQL. Se falhar depois de parar a API, tenta restaurar o container/imagem anterior, mantém a migração já aplicada e os dados, e registra o diretório do backup. A recuperação automática não restaura um dump sobre o banco.

## Validação manual sem pagamentos reais

Depois de confirmar healthcheck e logs, valide usando somente credenciais e usuários de teste do Mercado Pago:

1. `docker compose ... ps` mostra `postgres` saudável e `api` em execução; `/health` retorna status online e PostgreSQL conectado.
2. Revise os logs do serviço `api` para erros de webhook/worker, sem copiar tokens para o relatório.
3. Com o fluxo sandbox e uma conta de teste, crie um pedido de teste e use o mecanismo de aprovação de teste do Mercado Pago. Não use credenciais de produção nem um pagador real.
4. Confirme no banco e na interface de teste: pedido aprovado uma única vez, horário reservado, confirmação automática e registro na dashboard.
5. Confirme notificações para cliente e profissional através dos canais de teste disponíveis.
6. Para webhook/worker, valide recebimento, processamento e ausência de duplicação repetindo consulta/notificação de teste. Se as credenciais não existirem, registre esses itens como pendentes; não habilite credenciais reais para completar a validação.
7. Confirme que a configuração efetiva continua `MP_ENVIRONMENT=test` e `PIX_PRODUCTION_ORDERS_ENABLED=false`.

Como o PR permanece aberto, valide a interface com um preview já disponível e apontado para o backend de teste. Esta atualização de VPS não publica o frontend.

## Rollback

Localize no log o caminho exato indicado em `Backup/rollback`. Execute na VPS:

```bash
sudo env APP_DIR=/opt/isabele bash /usr/local/sbin/atualizar-vps-pix rollback /opt/isabele-backups/pix-update-<timestamp>-<commit>
```

O rollback recria somente o serviço `api` usando o ID da imagem anterior salvo no backup; mantém dados e migração 010 e desliga webhook/worker. Depois, valide `/health` e os logs. O rollback não reverte o schema: restaurar o dump é uma operação separada, que exige avaliação e janela de manutenção para evitar perda de dados posteriores ao backup.

## Ativar PIX real futuramente

Produção continua desligada neste procedimento. Antes de habilitá-la em uma mudança separada, preparar e validar:

- Conta Mercado Pago aprovada para produção e credenciais de produção emitidas para o aplicativo correto.
- Chave PIX cadastrada e apta a receber na conta beneficiária correta.
- `MP_ACCESS_TOKEN_PRODUCTION` e segredo de assinatura do webhook de produção guardados no gerenciador de segredos da VPS, sem colocá-los no Git, script, log ou frontend.
- URL HTTPS pública de webhook configurada no painel Mercado Pago para os eventos de Orders usados pelo backend; validar assinatura e conectividade em ambiente controlado.
- Migração 010 aplicada e schema verificado; `MP_ENVIRONMENT=production` e `PIX_PRODUCTION_ORDERS_ENABLED=true` somente em uma implantação explicitamente aprovada.
- Primeira cobrança real, valor de limite, janela de observação, conciliação e rollback aprovados antes da ativação. Este checklist não ativa nada.
