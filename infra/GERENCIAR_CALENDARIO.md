# Gerenciar Calendário — operação e implantação segura

O Gerenciar Calendário permite que uma administradora ativa feche e reabra
intervalos de 30 minutos para organizar a disponibilidade, inclusive datas
negociadas em pacotes externos ao aplicativo. A função não vende/cadastra
pacotes nem cria agendamentos, cobranças PIX, notificações ou eventos no Google
Calendar.

## Janela administrativa e janela pública

- A administração navega dinamicamente do mês atual até os dois meses seguintes,
  considerando o fuso `America/Sao_Paulo`; a lista avança corretamente na virada
  do ano e datas passadas não podem ser alteradas.
- A validação administrativa (`validarDataGerenciavel`) é separada da validação
  pública (`validarDataNaJanela`). A administradora pode gerenciar dezembro de
  2026 enquanto esse mês continuar fechado para reservas online.
- A validação pública de dezembro de 2026 permanece inalterada. A interface de
  administração não amplia a janela pública de reservas.
- Os bloqueios persistem em `public.agenda_bloqueios`; a disponibilidade pública
  consulta essa tabela, então os bloqueios continuam valendo se dezembro for
  liberado posteriormente.

## Contratos da API

Todas as rotas exigem Firebase Auth e usuário com `role: admin` e `ativo: true`.

- `GET /admin/calendario?data=YYYY-MM-DD`: consulta bloqueios e ocupações do dia.
- `POST /admin/calendario`: contrato individual preservado:
  `{ "data": "2026-11-05", "acao": "fechar", "horas": [840, 870] }`.
- `POST /admin/calendario/lote`: fecha ou reabre várias datas em uma única
  transação:
  `{ "acao": "fechar", "datas": [{ "data": "2026-11-05", "horas": [840, 870] }, { "data": "2026-12-03", "horas": [840, 870] }] }`.

Os horários são minutos desde meia-noite e cada item representa 30 minutos.
Para fechar, a API valida todas as datas e intervalos, adquire os mesmos locks
`pg_advisory_xact_lock` usados pela agenda em ordem de data, reconsulta reservas
PIX e agendamentos ativos do Firestore e só grava depois de validar o lote
inteiro. Qualquer conflito devolve HTTP 409 com data/intervalo e faz rollback
completo. A reabertura também é atômica e remove somente linhas de bloqueio;
reservas existentes nunca são alteradas. O limite é 93 datas e 2.400
intervalos por solicitação.

`GET /pix/disponibilidade` continua considerando bloqueios administrativos,
reservas PIX e agendamentos confirmados. As regras de dias/horários públicos,
almoço, cancelamento, reagendamento e bloqueio público de dezembro não são
alteradas por esta funcionalidade.

## Erros da consulta na tela

A tela mostra o status HTTP e a mensagem segura retornada pela API para erros de
autenticação, permissão, validação ou indisponibilidade, diferencia falhas de
rede/timeout e oferece **Tentar novamente**. Requisições de consulta anteriores
são abortadas ao trocar de dia e respostas obsoletas não substituem a seleção
atual.

## Testes locais

Na raiz do repositório:

```sh
npm --prefix infra/backend ci
npm --prefix infra/backend test
node scripts/agenda-regras.test.mjs
node scripts/verify-structure.mjs
```

Os testes da rota usam pools e Firestore falsos em memória; não consultam dados
reais nem criam bloqueios. Não usar o Preview da Vercel como ambiente de teste:
as rotas `/api` do Preview apontam para a API e o PostgreSQL reais da VPS.

## Implantação segura na VPS

Esta PR não executa implantação, migração ou teste de escrita na VPS. Quando a
implantação for aprovada e agendada, seguir esta ordem:

1. Confirmar revisão e merge aprovados; identificar o commit exato que será
   implantado e registrar o commit/imagem atual para rollback.
2. Fazer backup consistente do PostgreSQL e confirmar que o arquivo pode ser
   lido/restaurado. Não usar comandos de limpeza nem testar escritas na base
   real.
3. Atualizar primeiro a API com o commit aprovado, usando o procedimento
   operacional versionado (`infra/scripts/atualizar-vps-pix.sh`) e uma revisão
   explícita dos parâmetros `BRANCH`/commit. O script existente pode aplicar a
   migração 018 condicionalmente; esta alteração não adiciona nem modifica
   migrações. Se 018 já estiver aplicada, confirmar isso antes da execução.
4. Verificar health check, versão/commit e logs. Fazer apenas uma consulta
   autenticada `GET /admin/calendario?data=...` em data futura trabalhada; não
   executar POST de fechamento/reabertura como smoke test em produção.
5. Somente depois de a API atualizada estar saudável, publicar a interface
   correspondente. Não usar Preview da Vercel para operações de escrita, pois
   ele utiliza a API e o banco reais.
6. Monitorar erros da rota e manter disponíveis o backup, a imagem e o commit
   anteriores. Em rollback, restaurar API e frontend compatíveis; não apagar
   `agenda_bloqueios`, pois isso reabriria horários que foram comprometidos.

## Limites e rollback

Não é necessário executar migração nova. A tabela `public.agenda_bloqueios` da
migração 018 é reutilizada. Se uma data ou intervalo conflitar com PIX ou
agendamento ativo, o lote inteiro falha e a profissional precisa revisar a
seleção. O rollback da aplicação não deve remover bloqueios persistidos sem
reconciliação operacional, para que horários comprometidos não se tornem
reserváveis inadvertidamente.
