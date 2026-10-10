# Atualização controlada da VPS (PIX)

Este roteiro é para uma execução única, iniciada manualmente pelo responsável. O script não foi executado nesta revisão. A VPS não é acessada, a migração 010 não é aplicada e nenhuma cobrança é criada.

## O que o script verifica e preserva

A instalação informada usa `/opt/isabele-nails/infra/compose.yaml`, o override local `/opt/isabele-nails/infra/compose.override.yaml` e o arquivo adicional `/root/isabele-codex-pix-teste-20261010-125718.compose.yaml`. O script identifica a configuração ativa pelas labels do container `api` e exige que cada arquivo conhecido existente conste nessa configuração. Ele também guarda todos os arquivos Compose ativos, a configuração renderizada, os ambientes dos containers, os mounts, o ID da imagem antiga, o estado/diff/untracked do checkout e um dump do PostgreSQL.

A configuração efetiva renderizada pode conter senhas, tokens, chaves VAPID e referências Firebase. Os arquivos de backup ficam sob diretório `root` com permissões restritas. O script não escreve o conteúdo dos segredos no log. Antes de qualquer parada, compara as variáveis do Compose renderizado com o ambiente do container ativo e compara os mounts do Compose com os mounts reais (incluindo o arquivo Firebase). Se não conseguir reconstruir a mesma configuração, se faltar uma variável crítica, se algum volume divergir, se o PIX não estiver em `test` ou se a flag de produção não estiver explicitamente desligada, aborta sem parar serviços nem aplicar a migração.

O override de atualização muda apenas o contexto de build do serviço `api`; mantém as variáveis e configurações renderizadas, incluindo PostgreSQL, Firebase, Push, Mercado Pago, volumes, portas, redes e políticas do Compose. O serviço PostgreSQL não é recriado. A cópia de trabalho em `/opt/isabele-nails` não recebe checkout, reset, stash ou limpeza. A imagem anterior e o snapshot efetivo são usados pelo rollback. A migração 010 e os dados ficam preservados no rollback; o dump não é restaurado automaticamente.

## Requisitos antes de executar

- O checkout em `/opt/isabele-nails` deve apontar para `joadlsilvaseo-png/isabelenailsapp` e conseguir fazer `git fetch` da branch privada.
- Docker Compose v2, Git, `flock`, `curl`, Python 3, `realpath`, `tar` e `pg_dump` dentro do container PostgreSQL.
- O serviço ativo precisa ter as labels padrão do Docker Compose com projeto, diretório de trabalho e lista dos arquivos `-f`.
- Espaço livre para dump, snapshot de configuração, worktree e imagem nova.
- O SSH deve usar a chave já configurada no `~/.ssh/config`, no `ssh-agent` ou no caminho padrão do OpenSSH. Nenhuma chave é copiada para o servidor por este roteiro.

## Transferir e iniciar pelo Windows PowerShell

Abra o PowerShell na raiz de qualquer clone local do repositório. O bloco busca a branch remota e cria um worktree temporário isolado, sem trocar de branch nem tocar em alterações locais. Informe o IP ou alias SSH já configurado em `$VpsHost`. O OpenSSH reutiliza a chave indicada no seu `config`/agent/default.

```powershell
$ErrorActionPreference = 'Stop'
$VpsHost = "root@IP_OU_ALIAS_SSH"
$Branch = 'codex/correcao-pix-20261010'
git fetch origin "refs/heads/${Branch}:refs/remotes/origin/${Branch}"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao buscar a branch do PR.' }
$DeployDir = Join-Path $env:TEMP ("isabele-pix-" + [guid]::NewGuid().ToString('N'))
git worktree add --detach $DeployDir "origin/$Branch"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar worktree temporario.' }
try {
    $Script = Join-Path $DeployDir 'infra\scripts\atualizar-vps-pix.sh'
    scp $Script "${VpsHost}:/tmp/atualizar-vps-pix.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao transferir o script.' }
    ssh $VpsHost "sudo install -o root -g root -m 0750 /tmp/atualizar-vps-pix.sh /usr/local/sbin/atualizar-vps-pix && sudo env APP_DIR=/opt/isabele-nails bash /usr/local/sbin/atualizar-vps-pix start"
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar o script na VPS.' }
}
finally {
    git worktree remove $DeployDir
}
```

O segundo comando somente inicia o processo; ele informa PID e log persistente. Por padrão, logs ficam em `/var/log/isabele-nails-deploy/`. Consulte os mais recentes:

```powershell
ssh $VpsHost "sudo ls -lt /var/log/isabele-nails-deploy"
```

Acompanhe o arquivo cujo nome foi informado pelo script:

```powershell
ssh $VpsHost "sudo tail -f /var/log/isabele-nails-deploy/NOME_DO_LOG.log"
```

Use a versão do script atualizada junto ao PR. O script busca o commit mais recente de `codex/correcao-pix-20261010`, cria um worktree separado em `/opt/isabele-nails-releases/` e preserva o checkout existente.

## Etapas executadas pelo script

1. Descobre a instância `api` ativa e os arquivos Compose que a criaram, incluindo os overrides local e adicional. Confere credenciais, flags, volumes, Firebase e demais variáveis efetivas contra o container.
2. Salva a configuração renderizada e os arquivos-fonte Compose com acesso restrito; registra alterações locais e imagem anterior.
3. Gera dump PostgreSQL antes de parar qualquer serviço.
4. Constrói o backend do commit mais recente em worktree isolado.
5. Para somente `api`, aplica `infra/migrations/010_pix_webhook_ambientes.sql` com `ON_ERROR_STOP` e atualiza somente `api` usando o snapshot efetivo do Compose.
6. Verifica `/health` e a conexão PostgreSQL. Registra a contagem da fila por ambiente.

A produção não é alterada para um valor presumido: se o backend ativo não estiver em `MP_ENVIRONMENT=test` e com `PIX_PRODUCTION_ORDERS_ENABLED=false` explícito, o script aborta antes de qualquer parada. As credenciais de teste/produção e os flags atuais são copiados exatamente do ambiente efetivo; nenhuma credencial é impressa ou enviada para serviços externos.

## Validação integrada, sem pagamentos reais

Depois do healthcheck, use apenas contas e credenciais de teste do Mercado Pago:

1. Confirme `api` saudável, `postgres` saudável e `/health` com PostgreSQL conectado.
2. Revise logs da API para erros do webhook/worker sem copiar segredos para mensagens.
3. No sandbox, crie uma Order de teste e use o mecanismo de aprovação de teste do Mercado Pago. Não use pagador nem credenciais de produção.
4. Confirme aprovação única, reserva, confirmação automática e dashboard.
5. Confirme notificações para cliente e profissional pelos canais de teste disponíveis.
6. Confirme webhook/worker, retry e ausência de duplicações com eventos repetidos de teste. Se as credenciais de teste necessárias não estiverem presentes ou a URL pública não estiver pronta, registre validação pendente; não substitua a configuração por defaults.
7. Confirme que a configuração ativa continua em `test` e que produção segue desligada.

O script não cria Orders, não realiza pagamentos, não chama Google Apps Script e não publica o frontend. Com o PR aberto, valide a interface pelo preview já disponível e apontado para backend de teste.

## Rollback

Use o caminho `Backup e configuração efetiva anterior` registrado no log. O rollback pode ser solicitado mesmo que a API esteja indisponível, pois usa os arquivos no backup:

```powershell
$VpsHost = "root@IP_OU_ALIAS_SSH"
$Backup = "/opt/isabele-nails-backups/pix-update-DIRETORIO_INFORMADO_NO_LOG"
ssh $VpsHost "sudo env APP_DIR=/opt/isabele-nails bash /usr/local/sbin/atualizar-vps-pix rollback $Backup"
```

O comando sobe somente o serviço da API com a imagem anterior e a configuração efetiva salva, incluindo ambientes, credenciais, mounts Firebase, Push, Mercado Pago e demais opções do Compose. Depois confira healthcheck e logs. A migração 010 e o banco permanecem como estão. Restaurar o dump é uma operação separada, que exige análise e janela de manutenção para evitar apagar dados criados após o backup.

## PIX real em uma etapa futura

Este procedimento não ativa produção. Antes de qualquer ativação separada:

- Conta Mercado Pago habilitada para produção e credenciais emitidas para o aplicativo correto.
- Chave PIX cadastrada na conta beneficiária correta.
- `MP_ACCESS_TOKEN_PRODUCTION` e `MP_WEBHOOK_SECRET_PRODUCTION` guardados no gerenciador de segredos da VPS, fora do Git, dos logs e do frontend.
- URL HTTPS pública configurada no Mercado Pago para os eventos Orders usados pelo backend; assinatura, conectividade e tratamento de repetição validados.
- Migração 010 aplicada/revisada; `MP_ENVIRONMENT=production` e `PIX_PRODUCTION_ORDERS_ENABLED=true` somente em implantação futura explicitamente autorizada.
- Limite da primeira cobrança, conciliação, janela de observação e rollback aprovados antes da ativação.
