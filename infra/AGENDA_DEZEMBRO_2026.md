# Agenda especial — dezembro de 2026 (Isabele Mariana Nails)

## Estado de produção e regra de segurança

Em 04/11/2026, o responsável autorizou abrir dezembro para as clientes cadastradas no aplicativo, consideradas fixas pela profissional. A constante `AGENDA_DEZEMBRO_2026_ABERTA`, em `infra/backend/src/agendamentoRegras.mjs`, passa a ser **true** nesta release. A mesma regra é importada pelo frontend e validada na API.

**Atenção à publicação:** modificar a branch no GitHub não significa que a agenda já esteja aberta em produção. Primeiro publicar e validar a API na VPS; depois publicar o frontend na Vercel e validar cliente e admin. Durante a transição, deixar o frontend antigo fechado evita mostrar horários antes de a API estar pronta. O cadastro de novas clientes continua habilitado; não existe validação de cliente fixa no backend.

Não executar reservas PIX reais, não criar agendamentos de teste e não manipular
registros de `agenda_bloqueios` para validar estes ajustes.

## Calendário definitivo combinado

| Datas de dezembro/2026 | Expediente (início — **encerramento final**) | Restrições |
| --- | --- | --- |
| 01–05 | Regras semanais normais (terça a sábado) | Todos os serviços |
| 06 e 07 | Fechado | Nenhum |
| 08–12 | Regras semanais normais (terça a sábado) | Todos os serviços |
| 13 | Fechado | Nenhum |
| 14 (segunda) | 09h–20h | Todos os serviços |
| 15 (terça) | Fechado | Nenhum |
| 16 (quarta) | 13h–20h | Todos os serviços |
| 17 e 18 | 09h–20h | Suspender pedicure simples e em gel |
| 19–23 (inclusive domingo e segunda) | 07h–22h | Suspender pedicure simples e em gel |
| 24 | 07h–16h | Somente aplicação de alongamento, banho de gel, manicure simples e manicure em gel; nenhum tipo de manutenção ou pedicure |
| 25, 26 e 27 | Fechado | Nenhum |
| 28, 29 e 30 (inclusive segunda) | 09h–20h | Todos os serviços |
| 31 | Fechado | Nenhum |

Em dias com regra semanal habitual, preservar exatamente as restrições de
terça, quarta e sábado (horários de início e durações permitidas) e de quinta
e sexta (horários de abertura e encerramento). Sem pausa fixa de almoço;
a profissional controla intervalos pelo Gerenciar Calendário.

**Atualização semanal em 04/11/2026:** quintas-feiras comuns agora atendem
**11h–21h** e sextas-feiras comuns, **09h–21h** (último início possível
às 20h30, para serviço de até 30 minutos). Datas de dezembro com expediente
especial permanecem com seus horários próprios, inclusive 17 e 18/12 até 20h.


**Encerramento é o horário em que o último serviço precisa ter terminado.**
A validação usa `início + duração real <= encerramento`. Os possíveis inícios
são em intervalos de 30 minutos; o sistema não deve oferecer uma duração que
avance além do horário final.

### Restrições de serviços

- 17–23: pedicure simples/em gel suspensos; outros serviços mantidos.
- 24: permitir somente aplicações de alongamento, banho de gel, manicure
  simples e manicure em gel. Nunca permitir manutenção nem pedicure.
- 28–30: todas as categorias/serviços voltam ao fluxo regular.
- A validação considera o `nome` e a `categoria` presentes no documento
  do serviço no Firestore. Antes da abertura pública, auditar os nomes e
  categorias reais de serviços para conferir equivalências como
  `Esmaltação em Gel` na categoria Manicure versus Pedicure.

## Implementação

- `infra/backend/src/agendamentoRegras.mjs`: configuração por dia,
  permissões de serviços e chave de abertura pública.
- `infra/backend/src/pixDisponibilidade.js`: abertura, encerramento e
  restrição por data, respeitando a configuração de abertura e os dias fechados.
- `infra/backend/src/pixReservas.js` e
  `infra/backend/src/agendamentosIsencaoPix.js`: validação de serviços
  antes de criar reserva PIX, agendamento sem sinal ou reagendamento.
- `agendamento.js`: preparação da agenda pública, permanecendo oculta
  enquanto a chave estiver desligada.
- `admin-calendario.js`, `admin-calendario-regras.mjs`,
  `infra/backend/src/agendaBloqueios.js`: grade administrativa atualizada,
  inclusive aberturas de domingo/segunda, sem desbloquear a agenda pública.
- Não há alteração de esquema, migração SQL ou edição de dados existentes.

## Testes (sem banco real e sem pagamentos)

Na raiz do repositório:

```sh
node --test scripts/agenda-dezembro-2026.test.mjs
node --test scripts/agenda-regras.test.mjs
node --test scripts/admin-calendario-regras.test.mjs
node --test infra/backend/test/agendamentoDisponibilidade.test.js
node --test infra/backend/test/agendaBloqueios.test.js
```

Com a chave habilitada, validar as 31 datas: os oito dias fechados permanecem indisponíveis, e os demais seguem horários por dia e duração do serviço. Testar restrições de pedicure e serviços permitidos em 24/12, mais disponibilidade, PIX, isenção e reagendamento com simulações isoladas. Não criar pagamentos ou agendamentos reais para validar.

## Publicação segura — abertura autorizada em 04/11

1. Validar os testes automatizados, inclusive os cenários com a chave ativa, sem alterar reservas reais.
2. Auditar os **nomes e categorias reais no Firestore**, sobretudo serviços com nomes como "Esmaltação em Gel", e verificar a configuração do sinal PIX por serviço; confirmar os intervalos manuais já bloqueados.
3. Publicar **primeiro o backend** versionado na VPS pelo script oficial (backup, preflight de migrações, rollback), sem resetar o checkout local nem alterar a configuração de pagamento.
4. Com o frontend ainda fechado, testar a API autenticada para 14/12 (200) e 15/12 (400: Dia sem atendimento); verificar integridade dos containers e o commit de produção.
5. Publicar **depois o frontend** na Vercel, com cache PWA renovado e a mesma revisão das regras. Conferir dezembro visível a clientes, dias sem expediente ocultos, slots e restrições de serviço.
6. Verificar PIX, isenção e reagendamento sem executar cobranças reais ou criar reservas de teste em produção. Caso haja problemas, interromper a abertura pública e restaurar a imagem/API com o mecanismo de rollback, observando que isso não reverte migrações.
7. Este release não implementa filtro de clientes fixas: a profissional declarou que quem usa atualmente o app é cliente fixa. Contas novas que se cadastrarem também poderão ver a agenda aberta; se isso não for desejado, implantar uma regra de elegibilidade específica.

**Atenção:** não basta implantar apenas a tela ou apenas a API. O histórico de agendamentos, os bloqueios administrativos e as configurações financeiras devem permanecer intactos.
