# Agenda especial — dezembro de 2026 (Isabele Mariana Nails)

## Estado de produção e regra de segurança

A agenda pública de dezembro **permanece fechada**.
A constante `AGENDA_DEZEMBRO_2026_ABERTA`, em
`infra/backend/src/agendamentoRegras.mjs`, deve continuar **false**
até autorização expressa do responsável. É importada pelo frontend e usada
na validação da API. A grade pública também oculta dezembro enquanto a chave
estiver desligada.

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
  restrição por data, sem mudar o bloqueio de dezembro.
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

Com a chave ainda desativada, devem ser testadas as 31 datas
de dezembro; todas as datas continuam indisponíveis ao público.
As regras excepcionais são validadas de modo isolado, sem abrir a agenda.

## Publicação segura

1. Manter a chave **false**. Revisar o catálogo real de serviços e testar
   os fluxos de PIX, isenção e reagendamento em ambiente de testes isolado.
2. Publicar o backend na VPS com o script oficial, backup e rollback, e
   validar a API e o banco. A chave desligada evita criar reservas em dezembro.
3. Confirmar que o frontend administrativo e backend têm o mesmo commit,
   especialmente para segundas e domingos excepcionais.
4. **Somente após nova autorização explícita**, mudar a chave de abertura
   para **true** e planejar implantação sincronizada no frontend e backend;
   a janela pública será ampliada até 31/12 para permitir o mês inteiro
   em novembro. Validar que os dias marcados como fechados continuam fechados.
5. Nunca habilitar PIX em dezembro só com o frontend nem remover bloqueios
   administrativos para forçar a abertura.
