# Calendar unificado — Fase 2 (Apps Script preparado, NÃO publicado)

**Data:** 08/11/2026  
**Código preparado:** `infra/apps-script/isabele-calendar-unificado.gs`  
**Situação:** código-fonte de integração para revisão. Nenhuma implantação na conta da Isabele; nenhuma URL ou worker de produção foi alterado.

## 1. Decisão: um único Apps Script, da Isabele

Ao final das fases seguintes, as operações `AGENDAR`, `REAGENDAR`, `CANCELAR` e `ATUALIZAR` irão para a **mesma implantação Web App do projeto da conta da Isabele**, e sempre serão disparadas pela API Node.js na VPS, nunca diretamente pelo browser.

O Apps Script usa `ISABELE_CALENDAR_ID` da configuração segura do projeto (em vez de `getDefaultCalendar()`). Este ID deverá corresponder ao calendário que contém os eventos existentes; **conta que executa o projeto, calendário proprietário e ID de calendário são entidades distintas**.

**Não implantar o arquivo ainda.** O backend atual não fornece `operationId`, `origemDataInicio` e autenticação no formato exigido em todos os fluxos. Implantá-lo diretamente interromperia agendamentos reais.

## 2. Contrato proposto do endpoint unificado

Todas as requisições são `POST` JSON, originadas **somente do backend**, via HTTPS. Campos comuns:

| Campo | Obrigatório | Descrição |
|---|---|---|
| `acao` | Sim | `AGENDAR`, `REAGENDAR`, `CANCELAR` ou `ATUALIZAR` |
| `eventId` | Sim | ID interno estável do agendamento; não é um Google Event ID |
| `operationId` | Sim | UUID estável para a mesma tentativa/retentativas; não gerar um novo em retries |
| `integracaoToken` | Sim | Token longo de serviço fornecido pela **API**, nunca enviado ao navegador |
| `googleEventId` | Opcional | ID real previamente conferido e registrado pelo backend; o GAS revalida a identidade |
| `nomeCliente`, `servico` | AGENDAR/REAGENDAR/ATUALIZAR | Título do evento, sem confiar na identidade como prova |
| `dataInicio` | AGENDAR/REAGENDAR/ATUALIZAR | Data de destino no formato `AAAA-MM-DDTHH:mm:ss` em São Paulo (ou offset explícito) |
| `duracaoMinutos` | AGENDAR/REAGENDAR/ATUALIZAR | Inteiro entre 1 e 600 |
| `origemDataInicio` | REAGENDAR | Data/hora de **origem do evento no Google Calendar**, não a nova data |
| `origemDuracaoMinutos` | REAGENDAR | Duração original para impedir alteração de evento modificado |
| `origemDataInicio` | CANCELAR (quando disponível) | Segurança adicional na conferência do evento; necessária para recuperar vínculos ausentes |

`ATUALIZAR` não muda o início: deve coincidir com o horário real, alterando título e duração. `REAGENDAR` preserva o evento e exige origem consistente. `CANCELAR` só remove o evento localizado pelo vínculo verificável e confirma ausência após a remoção. `AGENDAR` é idempotente por `eventId` e não recria evento cancelado.

Exemplo **ilustrativo** de reagendamento (não contém credencial real):

```json
{
  "acao": "REAGENDAR",
  "eventId": "evt_exemplo_ficticio",
  "operationId": "11111111-1111-4111-8111-111111111111",
  "integracaoToken": "<fornecido-somente-pela-api>",
  "origemDataInicio": "2026-11-20T14:00:00",
  "origemDuracaoMinutos": 60,
  "dataInicio": "2026-11-21T10:00:00",
  "duracaoMinutos": 60,
  "nomeCliente": "Cliente Fictícia",
  "servico": "Serviço Fictício"
}
```

Resposta JSON esperada no sucesso: `{ "ok": true, "status": "REAGENDADO", "eventId": "...", "operationId": "...", "googleEventId": "...", "repeated": false }`. Para `ATUALIZAR`, também `updated: true`. Erros retornam `ok: false` com `errorCode` sem dados pessoais; **Apps Script pode responder HTTP 200 mesmo se `ok:false`**, logo o backend obrigatoriamente valida o corpo.

**Status e timeout no navegador:** `202` + operação pendente é permitido na API, mas o aplicativo só informa `Concluído` depois de confirmação persistida. Quando a confirmação é incerta, informar `Em processamento` e manter a proteção do horário.

## 3. Migração e preservação dos vínculos

Há dois esquemas de vínculo históricos:

| Origem | Identificação existente |
|---|---|
| Script na conta anterior, chamado pela outbox PIX/isentos | `isabele_evento_<eventId>` em **Script Properties daquele projeto**, e descrição `Agendamento no app: <eventId>` no evento |
| Script atual na conta da Isabele, chamado pelo navegador | `reserva_<eventId>` em **Script Properties do projeto dela**, tag `idReserva=<eventId>` no evento |

As propriedades de um projeto **não migram** automaticamente para o outro. A versão unificada lê os dois prefixos **caso existam no projeto em que for implantada**; grava somente o canônico `reserva_` em novas operações. Quando não há vínculo local, procura pelo **marcador de identidade** (tag exata ou descrição exata) nos horários de origem/destino. Se não houver identidade verificável ou houver ambiguidade, devolve erro e não cria outro evento.

O campo opcional `googleEventId` será fornecido pela futura tabela de vínculos, mas é obrigatório conferir o marcador no próprio evento antes de usá-lo. Eventos sem marcação confiável exigem revisão manual, nunca associação automática baseada apenas em título e horário.

**Atenção:** o caso isento relatado em 07/11/2026, em que a data do Firestore mudou mas o Calendar não, precisa ser reconciliado especificamente. Na API futura, `origemDataInicio` deve refletir a posição **efetiva do evento**, não simplesmente a data atual (possivelmente já alterada) no Firestore. A migração não pode mover esse evento automaticamente sem conciliação.

## 4. Segurança e execução

- No projeto Apps Script da **Isabele**, configurar Script Properties `ISABELE_CALENDAR_ID` e `ISABELE_INTEGRACAO_TOKEN` **somente na implantação**, com segredo aleatório >= 32 caracteres. Nunca colocar a chave no repositório, frontend, console ou print.
- Implantar Web App executando como conta com acesso de edição ao calendário correto, com autenticação **aplicacional obrigatória** por token. O Apps Script não consegue validar por si só o Firebase ID token do cliente; a API deve autenticar e autorizar antes de chamar o script.
- O script exige segredo em toda chamada, inclusive AGENDAR. Trocar a implantação GAS **antes da API** bloquearia integrações atuais.
- Lock curto `tryLock(4000)` com erro `CALENDARIO_OCUPADO`; backend faz retentativas com mesmo `operationId`, não repetições sem controle. O lock é global ao script, portanto o monitoramento de latência será necessário na implantação.
- Log do GAS somente contém ação/status/código genérico de erro. O banco futuro armazena histórico de estados/causa, sem segredos ou nomes de clientes.
- Script Properties não deve ser usado como único armazenamento de operações indefinidamente: a fonte de verdade das tentativas será PostgreSQL; o GAS mantém vínculo local para compatibilidade.
- Revisar acionadores de `sincronizarCancelamentos` do script legado antes de aposentá-lo. Essa função de planilha **não foi incorporada ao código unificado**: não pertence ao backend atual e pode ter efeitos próprios.
- Nenhum arquivo desta fase contém segredo real ou URL de implantação em uso.

## 5. Casos de diagnóstico previstos

| Código | Significado | Regra operacional |
|---|---|---|
| `EVENTO_NAO_LOCALIZADO` | Vínculo e marcador de identidade ausentes | Revisar vínculo; não criar clone |
| `VINCULOS_DIVERGENTES` | Dois IDs distintos para o mesmo agendamento | Revisar manualmente |
| `GOOGLE_EVENT_ID_NAO_VERIFICADO` | ID real fornecido não prova identidade do evento | Bloquear operação |
| `ORIGEM_DIVERGENTE` | Data/duração original já não corresponde ao evento | Conciliar primeiro |
| `CONFIRMACAO_INDEFINIDA` | Houve envio, mas leitura final não comprovou resultado | Estado incerto; não tratar como falha definitiva nem repetir sem verificar |
| `CALENDARIO_OCUPADO` | Lock ocupado por outra execução | Retentativa controlada |
| `NAO_AUTORIZADO` | Falha de autenticação entre VPS e GAS | Verificar configuração sem revelar segredo |

## 6. Trabalho ainda necessário (não executar na Fase 2)

**Fase 3 — Backend:** introduzir adaptador de contrato unificado, URL configurável, segredo server-side, `operationId` persistido, snapshots de origem; implementar saga para reagendamento **sem PIX** preservando ambas as janelas até conclusão; coordenar as filas existentes de PIX, cancelamento e troca de serviço; remover chamadas `no-cors` quando a API estiver implantada.

**Fase 4 — Observabilidade:** migração SQL aditiva candidata `023` para vínculos, operações e histórico; estados de reconciliação, bloqueio/reliberação segura e consulta admin, sem tocar em dados financeiros.

**Fase 5 — UX:** Sincronizando / Em processamento / Concluído / Falha; mensagens técnicas de diagnóstico seguras e status real após retorno do worker.

**Fase 6 — Implantação e testes:** apenas durante a implantação controlada executar testes para sucesso, conexão lenta, timeout, evento inexistente, evento movido, idempotência, concorrência, erros do GAS, dados legados e continuidade de PIX. Antes: backup PostgreSQL/Compose/imagem/API, inventário de gatilhos e propriedades, confirmação do calendário e scripts das duas contas; preparar rollback de código e procedimento separado para compensação de mudanças Calendar.

**Critério de conclusão da Fase 2:** fonte GAS unificada no GitHub, contrato de integração e migração documentado, sintaxe JS conferida; PR permanece draft e sem deploy. Avançar somente após OK da pessoa responsável.
