# Google Calendar API direto na VPS — Etapa OAuth (isolada)

**Data:** 08/11/2026  
**Objetivo:** substituir Apps Script no FUTURO, mas nesta etapa **somente preparar o OAuth 2.0 e testar leitura**.  
**Status:** desenvolvimento em branch, sem deploy nem migração aplicada.

## Arquitetura desta etapa

Rotas novas no backend Node.js:

| Método | Caminho backend | Proteção | Efeito |
|---|---|---|---|
| POST | `/oauth/google/connect` | Firebase JWT + usuário `usuarios/{uid}.role=admin`, `ativo=true` | Cria nonce e PKCE no PG, devolve `authorizationUrl`. **Não** altera Calendar |
| GET | `/oauth/google/callback` | `state` único persistido com expiração de 10 min + PKCE + client_secret | Troca código, confere identidade Google, lê acesso ao calendário e persiste refresh token cifrado |
| GET | `/oauth/google/status` | Firebase/admin | Diz se existe credencial persistida; **não** afirma que ainda está válida |
| GET | `/oauth/google/check` | Firebase/admin | Renova access token e consulta apenas o mínimo de metadados de eventos; **não** cria, move nem apaga eventos |

A camada Vercel atual mapeia o caminho público `/api/oauth/google/connect` para o backend `/oauth/google/connect`. O callback deve usar o endereço **direto da API**, não o site Vercel:

`https://isabelenailsapi.duckdns.org/oauth/google/callback`

**O cliente OAuth já foi configurado pelo responsável no Google Cloud, com escopo `calendar.events`, tipo Web App e a conta da Isabele adicionada como usuária de teste.** A implementação também solicita `openid email` para conferir a identidade autorizada.

## Configuração segura (NÃO colocar valores reais em GitHub/ChatGPT)

Usar os dados `client_id` e `client_secret` do JSON privado baixado no Google Cloud. Somente ao implantar na VPS, preencher em arquivo de configuração privado, acesso restrito:

```dotenv
GOOGLE_CALENDAR_OAUTH_ENABLED=false
GOOGLE_CALENDAR_OAUTH_CLIENT_ID=<client_id_do_json_privado>
GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=<client_secret_do_json_privado>
GOOGLE_CALENDAR_OAUTH_REDIRECT_URI=https://isabelenailsapi.duckdns.org/oauth/google/callback
GOOGLE_CALENDAR_OAUTH_ENCRYPTION_KEY=<32_bytes_aleatorios_codificados_em_base64url>
GOOGLE_CALENDAR_ID=isabelemarianavieiralima@gmail.com
GOOGLE_CALENDAR_EXPECTED_EMAIL=isabelemarianavieiralima@gmail.com
```

**Não utilizar a chave VAPID, senha Postgres, segredo Firebase ou segredo OAuth como chave de criptografia.** Gerar uma chave dedicada com 32 bytes aleatórios e mantê-la persistente. Perdê-la impede a decifragem do refresh token (será necessária nova autorização). Não imprimir a chave nem o client secret em logs, terminal compartilhado, prints ou PR.

O backend exige habilitação explícita com `GOOGLE_CALENDAR_OAUTH_ENABLED=true`, *após* aplicar a migração e fazer backup. Enquanto estiver `false`, as rotas retornam 503 sem consultar Google/SQL. A habilitação desta flag **não habilita nenhuma gravação no Calendar** nesta versão.

## Migração SQL aditiva

Arquivo `infra/migrations/023_google_calendar_oauth.sql`:

- `google_calendar_oauth_states`: hash SHA-256 do `state`, UID admin e PKCE cifrado, expiração curta. Consumido por DELETE/RETURNING atômico; um `state` não pode ser repetido.
- `google_calendar_oauth_credentials`: uma conexão Isabele, e-mail verificado e **somente refresh token cifrado em AES-256-GCM**. Nenhum access token persiste.
- Sem `ALTER` em `pix_reservas`, `pix_cobrancas`, `agendamentos`, `pix_calendar_outbox` ou tabelas de alteração/cancelamento. Não modifica registros financeiros.

Aplicar/validar em produção apenas durante implantação aprovada, com backup e SQL preflight. A migração 023 ocupa o próximo número livre; o planejamento anterior de futura migração geral para histórico de Calendar precisará usar **outro número**.

## Procedimento futuro de ativação (ainda NÃO executar)

1. Revisar PR e CI, aprovar explicitamente o merge/backend; tirar backup do PostgreSQL, do Compose, da imagem da API e da configuração efetiva.
2. Aplicar a migração 023 no PostgreSQL da VPS e validar estruturas; não alterar dados antigos.
3. Configurar os valores privados na VPS sem enviá-los para o GitHub, mantendo `GOOGLE_CALENDAR_OAUTH_ENABLED=false` até o backend atualizado estar implantado.
4. Implantar a API com essa flag ainda desligada; conferir `/health` e todos os workers antigos intactos.
5. Habilitar **somente OAuth** em ambiente controlado e reiniciar a API sem modificar flags de PIX ou alteracao de servico.
6. No frontend autenticado como administradora, fazer um POST para `/api/oauth/google/connect` com Bearer Firebase. Abrir `authorizationUrl` no navegador e autorizar usando a **conta da Isabele**, não conta pessoal.
7. Conferir `/api/oauth/google/status` e `/api/oauth/google/check` com o mesmo token administrador. `check` deverá responder `{conectado:true,contaCorreta:true,leituraCalendar:true}` sem qualquer criação/alteração de evento.
8. Antes do uso permanente da integração, resolver o modo de publicação e eventual verificação do Google OAuth: projeto externo em **Testing** pode gerar refresh token que expira em sete dias. Não desativar os Apps Scripts por essa mera autorização.

## Próximas etapas, depois da autorização de leitura

- Criar o adaptador Node.js para `events.insert/get/patch/delete` com confirmação de resposta e `googleEventId` persistente; **ainda não existe nesta etapa**.
- Conciliar vínculos entre o Firestore, PostgreSQL, Scripts antigos e eventos já existentes, sem clonar eventos sem identificação segura.
- Substituir a chamada frontend `no-cors` do reagendamento isento por saga backend durável, sem mudar as regras de disponibilidade e PIX.
- Migrar progressivamente os workers existentes (PIX pago, isento, cancelamento e alteração de serviço) usando flags independentes e reconciliação.
- Aposentar Apps Scripts legados **somente após validação comprovada em produção controlada**, inclusive seus acionadores de cancelamento.

## Segurança/limitações conhecidas

- Callback do Google não recebe Firebase JWT; sua proteção é nonce aleatório **de uso único**, PKCE e validação do e-mail Google esperado.
- Um token inválido/revogado só é detectado com a rota `check`; `status` confirma apenas armazenamento de credencial.
- Leitura de um calendário acessível não comprova que as futuras operações de escrita estão prontas. A migração dos agendamentos e os testes de escrita ficam para fases posteriores.
- A identidade do calendário foi configurada como `isabelemarianavieiralima@gmail.com`, que deve ser validada como **ID do calendário de atendimentos**, não confundida com a conta OAuth.
- A URL de callback contém o código OAuth transitório. Caddy/reverse proxy deve evitar registrar query strings sensíveis nos logs ao implantar.
- Sem alterar a API principal, o código usa `fetch` nativo do Node 24; não há biblioteca nova nem arquivo JSON confidencial versionado.

## Validação da branch

- Testes unitários simulados: flag desligada, autorização admin, PKCE/state, token cifrado, callback consumido uma só vez, identidade Google, bloqueio de acesso negado, leitura sem eventos modificados.
- CI existente roda `npm test` para backend; job SQL PostgreSQL 17 recebe validação aditiva da migração 023.
- **Nenhuma chamada real ao Google** nos testes de CI: fetch mockado. **Nenhuma migração aplicada na VPS** nesta etapa.
