# Diagnóstico de vínculos Calendar — apenas leitura

Objetivo: confirmar se o projeto Apps Script onde `ATUALIZAR` foi testado
possui as propriedades `reserva_<eventId>` e consegue resolver o
**mesmo evento existente** no Google Calendar. **Não executa AGENDAR,
REAGENDAR, CANCELAR nem ATUALIZAR. Não cria, atualiza ou apaga eventos.**

Na interface desse projeto Apps Script, crie um arquivo temporário
`DiagnosticoVinculos.gs` com o código abaixo. Salve e execute a função
`diagnosticarVinculosIsabeleSomenteLeitura`. Compartilhe apenas os contadores
retornados; não envie nomes de clientes nem IDs de eventos.

```javascript
function diagnosticarVinculosIsabeleSomenteLeitura() {
  const propriedades = PropertiesService.getScriptProperties().getProperties();
  const chaves = Object.keys(propriedades).filter(function (chave) {
    return chave.indexOf("reserva_") === 0;
  });
  const calendario = CalendarApp.getDefaultCalendar();
  const limite = Math.min(chaves.length, 30);
  let encontrados = 0;
  let tagsCompativeis = 0;
  let ausentes = 0;
  let divergentes = 0;

  for (let i = 0; i < limite; i++) {
    const chave = chaves[i];
    const googleEventId = propriedades[chave];
    const idReserva = chave.substring("reserva_".length);
    try {
      const evento = calendario.getEventById(googleEventId);
      if (!evento) {
        ausentes++;
      } else {
        encontrados++;
        const tag = evento.getTag("idReserva");
        if (tag === idReserva) tagsCompativeis++;
        else divergentes++;
      }
    } catch (erro) {
      ausentes++;
    }
  }

  console.log(JSON.stringify({
    tipo: "somente_leitura",
    propriedadesReserva: chaves.length,
    amostra: limite,
    eventosLocalizados: encontrados,
    tagsCompatíveis: tagsCompativeis,
    eventosNaoLocalizados: ausentes,
    tagsDivergentes: divergentes
  }));
}
```

**Interpretação:**

- `propriedadesReserva = 0`: esse projeto não tem o mapa de eventos do
  fluxo antigo; **não aponte** o backend para ele. Uma agenda compartilhada
  pode conter os mesmos eventos sem compartilhar as Script Properties.
- `tagsCompatíveis > 0`: existem vínculos resolvidos no mesmo projeto.
  É evidência útil, mas **não prova por si só** que todas as reservas em
  produção podem ser atualizadas. Verificar um agendamento conhecido e
  as configurações de produção antes de ativar a funcionalidade.
- `eventosNaoLocalizados > 0` ou `tagsDivergentes > 0`: interromper
  a liberação e investigar vínculo e calendário.

**Proteção do PR #20:** a API mantém `AGENDAR`/`CANCELAR` no endpoint
legado de `pixCalendarWorker.js`. A operação `ATUALIZAR` só é habilitada
quando a VPS recebe explicitamente **ambas** variáveis:

- `ISABELE_ALTERAR_SERVICO_ENABLED=true`
- `ISABELE_ALTERAR_SERVICO_APPS_SCRIPT_URL=https://script.google.com/macros/s/<ID_VALIDADO>/exec`

Sem essas variáveis, `PATCH /admin/agendamentos/servico` responde HTTP 503
**antes de criar fila ou escrever em Firestore/PIX**; o worker da nova feature
não consulta a fila. Essa proteção não afeta as rotas existentes, mas a
migração 020 e o deploy da API ainda exigem validação separada.
Não habilitar o recurso apenas porque uma implantação respondeu ao
ping: primeiro verificar os vínculos e testar em cenário isolado.
