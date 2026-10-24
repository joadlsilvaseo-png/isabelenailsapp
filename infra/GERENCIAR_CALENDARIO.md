# Gerenciar Calendário — implantação segura

Esta funcionalidade é exclusivamente administrativa e não gera eventos
no Google Calendar. Permite fechar e reabrir intervalos de 30 minutos
na janela mensal já existente, respeitando o bloqueio de dezembro de 2026.

## Ordem obrigatória para publicação

1. Fazer backup consistente do PostgreSQL da VPS e registrar o commit
   anterior da API para rollback.
2. Executar o script versionado `infra/scripts/atualizar-vps-pix.sh` com
   `BRANCH=feat/gerenciar-calendario-bloqueios-20261024`. O script confere
   a estrutura, cria backup PostgreSQL antes de parar a API, aplica a
   migração `018_agenda_bloqueios.sql` somente se pendente e atualiza a
   imagem Docker da API sem trocar os parâmetros PIX, credenciais e volumes.
   A migração é aditiva: não edita reservas nem pagamentos existentes.
3. Conferir `/health`, o commit da imagem e os logs da API na VPS.
4. Testar a API autenticada `GET /admin/calendario?data=YYYY-MM-DD`
   com uma conta administrativa real (consulta apenas), sem criar
   bloqueios de teste em dados de produção.
5. Somente após o backend estar atualizado e a migração aplicada,
   publicar o frontend na Vercel por merge na `main`.
6. Em sessão administrativa autorizada, testar fechamento e reabertura
   de um horário **sem reservas existentes**, conferir com uma conta
   cliente e reabrir após a validação. Nunca manipular um horário já
   reservado.

O script desta PR agora aplica a migração 018 automaticamente, de forma
condicional, **após criar o backup**, e aborta antes da parada da API se
houver estrutura parcial. Não utilizar uma versão antiga do script para
este deploy. Não deixar o frontend apontar para API ou tabela antigas.

## Contrato de dados

- `public.agenda_bloqueios`: data, início e fim em minutos,
  com chave (data, início); um registro por meia hora.
- `GET /admin/calendario?data=YYYY-MM-DD`: bloqueios e intervalos
  ocupados (somente admin ativo, autorizado via Firebase Auth).
- `POST /admin/calendario`: `{ "data": "...", "acao": "fechar" | "reabrir", "horas": [900, 930] }`.
  Os horários são minutos desde 00h00 (900 = 15h). Fechamentos
  sobrepostos a reservas ativas retornam HTTP 409 **sem gravar
  parcialmente o lote**.
- `GET /pix/disponibilidade` inclui, além das reservas, os bloqueios
  administrativos. Essa consulta continua read-only, no-store.
- Reserva PIX, reserva isenta e reagendamento validam os intervalos
  dentro da transação após obter o advisory lock por data.
- A janela mensal, horário do almoço, terça, quarta e o fechamento
  de dezembro são preservados.

## Regra de sobreposição

Uma reserva `[inicioReserva, fimReserva)` conflita com um bloqueio
`[inicioBloqueio, fimBloqueio)` quando:

```text
inicioReserva < fimBloqueio && fimReserva > inicioBloqueio
```

Exemplo: serviço 14h30–16h30 e fechamento 15h–16h = **conflito**.
Terminar exatamente às 15h, ou iniciar exatamente às 16h,
não gera conflito com esse bloqueio.

## Limites e testes

O aplicativo preserva o horário de início de sábado até 16h;
o fechamento de meia hora pode cobrir a duração do serviço após
as 16h. A tela não altera horários de atendimento fixos.

Executar `npm --prefix infra/backend test`. Não usar o Vercel
Preview como banco isolado: sua rota `/api` aponta para a VPS real.

## Rollback

Para rollback da API, restaurar a imagem Docker e configuração efetiva
usando o backup operacional. **Não remover automaticamente a tabela
`agenda_bloqueios`**, porque poderia excluir fechamentos registrados.
Para rollback do frontend, restaurar commit anterior da Vercel.
Planejar reconciliação antes de desativar a validação de bloqueios,
pois horários bloqueados não devem se tornar reserváveis inadvertidamente.
