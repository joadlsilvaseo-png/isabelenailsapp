# Buffer zero e Assistente Preventivo de Agenda

## O que mudou

- Inícios permanecem na grade de 15 minutos. A duração cadastrada do serviço continua ocupando seu intervalo real; só há conflito quando dois períodos se sobrepõem.
- A validação permanece nos caminhos Firestore e PostgreSQL, sob os advisory locks existentes. Reservas PIX `reservada`/`confirmada`, atendimentos ativos e bloqueios manuais continuam bloqueando sobreposições. Não houve alteração de tabela, constraint, preço, sinal, cobrança, polling, conciliação, Calendar ou notificação de agendamento.
- O texto da reserva informa a grade de 15 minutos e a disponibilidade conforme serviço e agenda.
- O assistente considera somente hoje e os próximos seis dias, no fuso `America/Sao_Paulo`, e lacunas entre períodos ocupados agregados de Firestore, reservas PIX e bloqueios. Ele só propõe uma avaliação; nunca fecha ou cria horários.
- Regras de classificação: lacuna de 15 minutos sem serviço permitido; todas as lacunas de 30 minutos; lacuna de 45 minutos sem serviço elegível ou onde só cabe serviço curto de baixa procura; e lacunas de 60 minutos ou mais sem serviço elegível. `Remoção de Gel` é reconhecida pelo nome normalizado como serviço de baixa procura; o catálogo também pode fornecer `baixaProcura: true`.
- Avisos automáticos usam `push_entregas` e `push_controle` existentes. A primeira varredura grava uma referência sem alertar sobre o histórico. Eventos têm fingerprint estável e são agrupados por data. Entregas pendentes obsoletas são canceladas; o worker revalida a agenda antes de enviar.
- O destino do push é `admin-calendario.html?data=YYYY-MM-DD`. Depois de confirmar Firebase Auth e o papel `admin` ativo, a tela valida a data dentro da janela administrável, abre o mês/dia e consulta os intervalos atuais. Não seleciona nem fecha nenhum horário automaticamente.

## Configuração e banco

Não há migração. São usadas as tabelas existentes `pix_reservas`, `agenda_bloqueios`, `push_entregas` e `push_controle`.

O monitor preventivo continua condicionado à flag já existente `ASSISTENTE_ENCAIXES_NOTIFICACOES_ENABLED=true`; o envio também depende do worker de Web Push já configurado. Nenhuma variável foi alterada nesta branch. A habilitação operacional deve ocorrer somente após revisão e publicação autorizada.

A página existente `admin-assistente.html` conserva a apresentação textual antiga de “encaixes excepcionais”. A nova classificação e suas justificativas já estão no retorno da API e nos avisos push. A revisão de textos e apresentação dessa página fica para uma etapa visual separada, conforme o escopo desta missão.

## Validação antes de publicar

1. Rodar `npm ci && npm test` em `infra/backend`.
2. Em ambiente de teste, verificar reserva de 90 minutos seguida por início exatamente no término; confirmar que o início seguinte fica livre e uma sobreposição de 15 minutos continua bloqueada.
3. Testar reservas PIX pendentes e confirmadas, bloqueios administrativos, horários especiais e datas de dezembro.
4. Com conta administradora, abrir um aviso de teste para `admin-calendario.html?data=YYYY-MM-DD`; conferir que a data é selecionada após autenticação e nenhum intervalo é marcado.
5. Confirmar a ausência de aviso retroativo no primeiro ciclo e o cancelamento de uma entrega pendente quando a lacuna deixa de existir.

## Publicação e rollback

Não executar nesta implementação. Após aprovação do PR, publicar o backend e o frontend em coordenação; preferir o backend primeiro para que horários recém-liberados pela interface já sejam aceitos pela API. Usar o procedimento oficial de release/backup/rollback do repositório para o backend; não aplicar SQL nem executar migração.

Se houver regressão, reverter frontend e backend para os artefatos anteriores pelo mesmo procedimento. A reversão do backend restaura o buffer anterior sem alterar dados. O mecanismo de snapshot tem chave nova e não sobrescreve o estado legado do assistente; avisos legados ainda pendentes são cancelados ao inicializar o novo monitor.
