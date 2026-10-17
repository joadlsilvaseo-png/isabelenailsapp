# Atualização controlada da VPS (PIX)

Este roteiro é para uma execução única, iniciada manualmente pelo responsável. O script não foi executado nesta revisão e a VPS não foi acessada. As migrações 010, 011 e 012 são verificadas pelo catálogo PostgreSQL; o script pula cada migração já aplicada e aborta se encontrar estado parcial. Não cria cobranças.

## Testes locais do procedimento

Na raiz do repositório, execute `python3 infra/scripts/test_atualizar_vps_pix.py` e `bash -n infra/scripts/atualizar-vps-pix.sh`. A suíte verifica a aceitação do sandbox e da produção habilitada, que os overlays de atualização/rollback não substituem ambiente, credenciais, volumes ou redes, o uso do snapshot efetivo no rollback, a decisão da migração 012 e a ausência de chamadas de cobrança/reembolso. Esses testes não acessam Docker, PostgreSQL, VPS, Mercado Pago ou Google Apps Script.

## O que o script verifica e preserva

A instalação informada usa `/opt/isabele-nails/infra/compose.yaml`, o override local `/opt/isabele-nails/infra/compose.override.yaml` e o arquivo adicional `/root/isabele-codex-pix-teste-20261010-125718.compose.yaml`. O script reconhece tanto labels que ainda apontam aos Compose de origem quanto o snapshot de recuperação em `pix-update-*/effective-before.yaml` com `restore-api.yaml` (ou overlay de atualização/rollback do próprio script). Para aceitar a recuperação, exige que os metadados do backup correspondam ao projeto, serviço e diretório de trabalho dos labels; depois renderiza essa configuração e valida API e PostgreSQL contra os containers em execução. Os Compose originais conhecidos também são copiados para o novo backup, mesmo quando os labels atuais apontam ao snapshot de recuperação.

A configuração efetiva renderizada pode conter senhas, tokens, chaves VAPID e referências Firebase. Os arquivos de backup ficam sob diretório `root` com permissões restritas. O script não escreve o conteúdo dos segredos no log. Antes de qualquer parada, compara rigorosamente todas as variáveis declaradas no Compose efetivo com API e PostgreSQL, confere a imagem configurada do banco e compara os volumes/mounts de ambos os containers (incluindo Firebase e o volume de dados do PostgreSQL). Uma declaração pass-through sem valor só é aceita se estiver ausente também no container. Os campos de webhook introduzidos após o commit implantado `844398b` não são exigidos nem criados pelo procedimento. Se projeto, configuração efetiva, credenciais ou mounts divergirem, ou `MP_ENVIRONMENT` tiver valor desconhecido, o script aborta antes de parar serviços ou aplicar a migração. Ambientes `test` e `production` são aceitos; nenhum flag de pagamento ou worker é habilitado, desabilitado ou reescrito.

O override de atualização muda o contexto de build e atribui à API uma referência imutável `isabele-nails-api:release-<commit>`; os labels da imagem e do container registram o SHA implantado. O Compose principal também declara a referência local `isabele-nails-api:local`. O Dockerfile copia os arquivos do backend com dono `node` e garante a propriedade de `/app`, incluindo `package.json` e `node_modules`, antes de executar como usuário não root.

## Cancelamento de agendamento com PIX

A migração 012 cria uma fila durável de cancelamentos. O backend valida novamente cliente/admin, grava a intenção, atualiza o Firestore e, na mesma transação PostgreSQL que conclui a intenção, muda somente a reserva vinculada para `cancelada`. A cobrança PIX e os eventos financeiros não são atualizados. Se Firestore ou PostgreSQL falhar depois que a intenção foi gravada, o worker tenta concluir novamente; o intervalo só deixa de ficar bloqueado quando a operação PostgreSQL é confirmada. O polling registra eventual pagamento, mas não recria um agendamento cancelado.

O worker de Calendar existente também envia `CANCELAR` ao Apps Script já usado pelo aplicativo, com o mesmo `calendarEventId` estável e tentativas persistentes. Para a fila ser processada, mantenha `PIX_CALENDAR_WORKER_ENABLED=true`, conforme a configuração já existente. A entrega é at least once: evitar duplicação externa em um timeout depende de o Apps Script tratar o mesmo `eventId` de forma idempotente. O código desse Apps Script não está neste repositório, então essa dependência não foi validada.

O restante da configuração renderizada permanece igual, incluindo variáveis, credenciais, PostgreSQL, Firebase, Push, Mercado Pago, volumes, portas, redes e políticas do Compose. O serviço PostgreSQL não é recriado. A cópia de trabalho em `/opt/isabele-nails` não recebe checkout, reset, stash ou limpeza. Antes do build, o script atribui à imagem anterior uma tag exclusiva guardada no backup; tanto o rollback automático quanto o manual usam essa referência persistente, sem depender de um ID `sha256` que possa deixar de estar disponível. As migrações 010/011/012 e os dados ficam preservados no rollback; o dump não é restaurado automaticamente.

## Requisitos antes de executar

- O checkout em `/opt/isabele-nails` deve apontar para `joadlsilvaseo-png/isabelenailsapp` e conseguir fazer `git fetch` da branch privada.
- Docker Compose v2, Git, `flock`, `curl`, Python 3, `realpath`, `tar` e `pg_dump` dentro do container PostgreSQL.
- O serviço ativo precisa ter as labels padrão do Docker Compose com projeto, diretório de trabalho e lista dos arquivos `-f`.
- Espaço livre para dump, snapshot de configuração, worktree e imagem nova.
- Windows PowerShell com OpenSSH e a chave existente em `$env:USERPROFILE\.ssh\isabele_locaweb_ed25519`. Nenhuma chave é copiada para o servidor por este roteiro.

## Transferir e iniciar pelo Windows PowerShell

Abra o PowerShell na raiz de qualquer clone local do repositório. O bloco busca a branch remota e cria um worktree temporário isolado, sem trocar de branch nem tocar em alterações locais. Ele usa explicitamente o host `root@177.153.68.33` e a chave privada existente em `$env:USERPROFILE\.ssh\isabele_locaweb_ed25519`. Antes do SCP, normaliza o script para LF e UTF-8 sem BOM; antes de instalar ou iniciar, o SSH executa `bash -n` no arquivo transferido.

```powershell
$ErrorActionPreference = 'Stop'
$VpsHost = 'root@177.153.68.33'
$SshKey = Join-Path $env:USERPROFILE '.ssh\isabele_locaweb_ed25519'
if (-not (Test-Path $SshKey)) { throw "Chave SSH não encontrada: $SshKey" }
$Branch = 'codex/correcao-pix-20261010'
git fetch origin "refs/heads/${Branch}:refs/remotes/origin/${Branch}"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao buscar a branch do PR.' }
$DeployDir = Join-Path $env:TEMP ("isabele-pix-" + [guid]::NewGuid().ToString('N'))
git worktree add --detach $DeployDir "origin/$Branch"
if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar worktree temporario.' }
try {
    $Script = Join-Path $DeployDir 'infra\scripts\atualizar-vps-pix.sh'
    $ScriptText = [System.IO.File]::ReadAllText($Script)
    $ScriptText = $ScriptText.Replace("`r`n", "`n").Replace("`r", "`n")
    if ($ScriptText.Contains("`r")) { throw 'Não foi possível normalizar o script para LF.' }
    $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Script, $ScriptText, $Utf8NoBom)
    scp -i $SshKey $Script "${VpsHost}:/tmp/atualizar-vps-pix.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao transferir o script.' }
    ssh -i $SshKey $VpsHost "bash -n /tmp/atualizar-vps-pix.sh && sudo install -o root -g root -m 0750 /tmp/atualizar-vps-pix.sh /usr/local/sbin/atualizar-vps-pix && sudo env APP_DIR=/opt/isabele-nails bash /usr/local/sbin/atualizar-vps-pix start"
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar o script na VPS.' }
}
finally {
    git worktree remove $DeployDir
}
```

O segundo comando somente inicia o processo; ele informa PID e log persistente. Por padrão, logs ficam em `/var/log/isabele-nails-deploy/`. Consulte os mais recentes:

```powershell
ssh -i $SshKey $VpsHost "sudo ls -lt /var/log/isabele-nails-deploy"
```

Acompanhe o arquivo cujo nome foi informado pelo script:

```powershell
ssh -i $SshKey $VpsHost "sudo tail -f /var/log/isabele-nails-deploy/NOME_DO_LOG.log"
```

Use a versão do script atualizada junto ao PR. O script busca o commit mais recente de `codex/correcao-pix-20261010`, cria um worktree separado em `/opt/isabele-nails-releases/` e preserva o checkout existente.

## Etapas executadas pelo script

1. Descobre a instância `api` ativa usando Compose original ou snapshot de recuperação validado por metadados. Confere que PostgreSQL pertence ao mesmo projeto e diretório. Compara todas as variáveis do Compose com API e PostgreSQL, e confere a imagem do banco e os volumes/mounts de ambos.
2. Salva a configuração renderizada e os arquivos-fonte Compose com acesso restrito; registra alterações locais e imagem anterior.
3. Gera dump PostgreSQL antes de parar qualquer serviço.
4. Constrói o backend do commit mais recente em worktree isolado.
5. Detecta as migrações 010, 011 e 012 pela estrutura de tabelas, colunas, constraints e índices. Se já estiverem aplicadas, não executa o SQL novamente. Se estiverem pendentes, aplica uma vez com `ON_ERROR_STOP`; estado parcial interrompe o processo antes da parada da API. Atualiza somente `api` usando o snapshot efetivo do Compose.
6. Confirma que o container foi recriado com a referência de imagem versionada e que o container e a imagem têm label de revisão igual ao commit Git alvo. Depois verifica `/health` e a conexão PostgreSQL e registra a contagem da fila por ambiente.

O ambiente e todos os flags financeiros são preservados exatamente como encontrados no Compose efetivo. Isso inclui `MP_ENVIRONMENT`, `PIX_PRODUCTION_ORDERS_ENABLED`, `PIX_POLLING_WORKER_ENABLED`, `PIX_WEBHOOK_ENABLED` e `PIX_WEBHOOK_WORKER_ENABLED`, além de credenciais. Na configuração de produção validada, a atualização mantém `MP_ENVIRONMENT=production`, `PIX_PRODUCTION_ORDERS_ENABLED=true`, `PIX_POLLING_WORKER_ENABLED=true`, `PIX_WEBHOOK_ENABLED=false` e `PIX_WEBHOOK_WORKER_ENABLED=false`. No sandbox, mantém os valores de teste que já estiverem configurados. Nenhuma variável nova ou segredo ausente é inventado. Se `MP_ENVIRONMENT` estiver ausente, o backend mantém seu padrão de `test`; para produção o valor precisa constar da configuração efetiva e coincidir com o ambiente em execução.

Como o polling existente está habilitado na VPS, ao iniciar a API atualizada ele poderá consultar Orders pendentes no Mercado Pago conforme a configuração já ativa. Essas consultas são de leitura/conciliação. O script de implantação não cria Orders/cobranças nem chama endpoints de estorno/reembolso. A migração 012 cria somente estruturas da fila de cancelamentos; não altera cobranças pagas, valores, reservas ou histórico financeiro.

## Validação integrada, sem pagamentos reais

Depois do healthcheck, use apenas contas e credenciais de teste do Mercado Pago:

1. Confirme `api` saudável, `postgres` saudável e `/health` com PostgreSQL conectado.
2. Revise logs da API para erros do webhook/worker sem copiar segredos para mensagens.
3. No sandbox, crie uma Order de teste e use o mecanismo de aprovação de teste do Mercado Pago. Não use pagador nem credenciais de produção.
4. Confirme aprovação única, reserva, confirmação automática e dashboard.
5. Confirme notificações para cliente e profissional pelos canais de teste disponíveis.
6. Confira nos logs `[PIX Polling]` a contagem de elegíveis, consultas, conciliações, erros, análises pendentes e próxima tentativa; os logs não imprimem IDs, nomes, tokens nem assinaturas. A implantação não altera o flag do worker.
7. Crie uma Order de teste e aprove o PIX no sandbox. Feche o navegador imediatamente após a emissão. Confirme no backend/PostgreSQL a mudança para paga, no Firestore o documento determinístico confirmado, e as notificações existentes para cliente e profissional. Verifique que uma consulta posterior do status não duplica crédito, agendamento ou Push. Não use pagamentos reais.
8. Valide usando o ambiente que já estava configurado antes da implantação. Para esta VPS, confirme que `MP_ENVIRONMENT=production`, `PIX_PRODUCTION_ORDERS_ENABLED=true`, `PIX_POLLING_WORKER_ENABLED=true`, `PIX_WEBHOOK_ENABLED=false` e `PIX_WEBHOOK_WORKER_ENABLED=false` foram preservados. Não faça pagamentos reais como parte da validação técnica do deploy.

O worker seleciona apenas Orders pendentes com `mp_order_id`, ambiente habilitado, horário de próxima consulta vencido e dentro do horizonte de reconciliação (72 horas por padrão). Ordens pagas com agendamento ainda não efetivado entram somente em uma retomada local, sem novo GET ao Mercado Pago. Ordens canceladas, encerradas e finalizadas ficam fora da seleção. Um lease de 120 segundos, `FOR UPDATE SKIP LOCKED` e advisory lock por cobrança reduzem trabalho concorrente; um lock global permite apenas um ciclo do worker entre réplicas. A consulta externa ocorre fora de transação PostgreSQL. O agendamento usa intervalos adaptativos (30 segundos no início, 60 segundos após cinco minutos, 120 segundos depois da reserva e 300 segundos em reconciliação mais antiga) com backoff e jitter em falhas. A janela global no PostgreSQL limita também consultas simultâneas ao endpoint `/pix/status`; o padrão local é 12 consultas por minuto e respeita o `Retry-After` do Mercado Pago. Os limites efetivos da API são definidos por conta/aplicação, portanto 12/min é uma proteção conservadora configurável, não uma garantia do limite contratado.

O horizonte de 72 horas evita polling infinito e não libera reservas com pagamento inconclusivo. Um pagamento aprovado depois de a reserva perder validade é creditado de modo idempotente e encaminhado à análise financeira existente; a rotina não cria um novo horário. Depois do horizonte, uma cobrança ainda pendente deixa de ser consultada automaticamente e exige reconciliação operacional; cobranças antigas não entram retroativamente na primeira ativação. A tabela de quota e os leases são locais ao PostgreSQL e se recuperam após reinício/expiração do lease.

O script não cria Orders, não realiza pagamentos, não solicita estornos/reembolsos, não chama Google Apps Script e não publica o frontend. Com o PR aberto, valide a interface pelo preview já disponível. Se a configuração efetiva for produção, não inicie uma Order de validação; confirme somente healthcheck, commit, logs e preservação de configuração.

## Rollback

Use o caminho `Backup e configuração efetiva anterior` registrado no log. O rollback pode ser solicitado mesmo que a API esteja indisponível, pois usa os arquivos no backup:

```powershell
$VpsHost = 'root@177.153.68.33'
$SshKey = Join-Path $env:USERPROFILE '.ssh\isabele_locaweb_ed25519'
$Backup = "/opt/isabele-nails-backups/pix-update-DIRETORIO_INFORMADO_NO_LOG"
ssh -i $SshKey $VpsHost "sudo env APP_DIR=/opt/isabele-nails bash /usr/local/sbin/atualizar-vps-pix rollback $Backup"
```

O comando sobe somente o serviço da API com a tag persistente da imagem anterior e o snapshot renderizado da configuração efetiva anterior, incluindo todos os valores de ambiente (também as flags PIX de produção), Firebase, Push, PostgreSQL, Mercado Pago, volumes, redes e opções do Compose. Os arquivos Compose fonte originais também ficam copiados no backup para auditoria; o rollback usa o snapshot efetivo, não tenta reconstituir a configuração a partir de arquivos que possam ter mudado. Assim, se o deploy foi iniciado com produção ativa, o rollback restaura a mesma configuração de produção ativa; se iniciou no sandbox, restaura o sandbox. Depois confira healthcheck e logs. As migrações 010/011/012 e o banco permanecem como estão; rollback de código não desfaz schema. O script nunca restaura ou apaga dados financeiros. Restaurar o dump é uma operação separada, que exige análise e janela de manutenção para evitar apagar dados criados após o backup.

## PIX real em uma etapa futura

Este procedimento não altera a ativação do PIX real. Para mudanças futuras de credenciais ou flags financeiras, faça uma revisão e autorização específicas. A checklist de configuração/validação continua sendo:

- Conta Mercado Pago habilitada para produção e credenciais emitidas para o aplicativo correto.
- Chave PIX cadastrada na conta beneficiária correta.
- `MP_ACCESS_TOKEN_PRODUCTION` e `MP_WEBHOOK_SECRET_PRODUCTION` guardados no gerenciador de segredos da VPS, fora do Git, dos logs e do frontend.
- URL HTTPS pública configurada no Mercado Pago para os eventos Orders usados pelo backend; assinatura, conectividade e tratamento de repetição validados.
- Migrações do ambiente revisadas. Neste deploy, a migração 012 é aplicada somente se pendente e aborta se parcial; não altera credenciais nem flags financeiros.
- Limite de cobrança, conciliação, janela de observação e rollback revistos antes de qualquer operação financeira separada.
