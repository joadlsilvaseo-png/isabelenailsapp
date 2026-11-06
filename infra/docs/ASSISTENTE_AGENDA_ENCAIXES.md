# Assistente de Agenda — encaixes excepcionais

## Objetivo
Auxiliar a Isabele a identificar exclusivamente oportunidades **entre dois atendimentos ativos** onde um serviço cabe sem sobrepor outro, mas **exigiria dispensar parte ou todo o buffer de 15 minutos**. Não lista horários normais nem períodos vazios na abertura/fechamento.

## Segurança
- Consulta somente por administradora Firebase ativa (`usuarios/{uid}`) e API autenticada.
- GET `/api/admin/assistente/encaixes?mes=YYYY-MM` ou `&data=YYYY-MM-DD`, apenas nos três meses administrativos.
- Dados de Firestore agendamentos e serviços, PostgreSQL reservas PIX e bloqueios. Uma fonte indisponível resulta em erro, nunca em sugestão inventada.
- Ignora serviços com duração inferior a 30 minutos (serviço de teste de 15 minutos não é oportunidade comercial).
- Ocupações reais e bloqueios nunca podem se sobrepor. Reservas PIX pendentes preservam o buffer integral.
- Agenda comum, pagamentos PIX, alteração de serviço, reagendamento e Calendar **não são alterados**.
- As sugestões podem ficar obsoletas após uma mudança. A profissional deve conferir o horário antes de negociar um atendimento manualmente.

## Alertas
- O monitor de alertas é um recurso **opcional e explicitamente configurável**:
  `ASSISTENTE_ENCAIXES_NOTIFICACOES_ENABLED=true` no container da API para ativá-lo.
- Reage às alterações do listener Firestore com pequeno debounce e faz reconciliação a cada 3 minutos, incluindo mudanças do PostgreSQL.
- Primeiro ciclo registra apenas a referência em `public.push_controle` e **não envia alerta retroativo**.
- Nos ciclos seguintes, apenas novas oportunidades geram registros em `push_entregas` (Central e Web Push existentes).
- Um alerta por dia, por ciclo; múltiplas oportunidades são agrupadas. O estado é persistente, evitando spam após reinícios.
- Se não houver administrador ativo ou fontes da agenda estiverem indisponíveis, o ciclo falha sem criar notificações.
- Push depende da configuração atual `PUSH_WORKER_ENABLED=true` e da assinatura do dispositivo.

## Implantação segura
1. Validar os testes automatizados e a prévia da branch.
2. Implantar a API de nova versão na VPS **antes de publicar o frontend**, preservando a configuração de PIX.
3. Confirmar saúde da API e testar GET com token administrador e 403 para conta de cliente.
4. Habilitar `ASSISTENTE_ENCAIXES_NOTIFICACOES_ENABLED=true` na configuração persistente da API, somente após a revisão; verificar que a leitura inicial é silenciosa e não entrega alertas em massa.
5. Integrar o frontend na `main` e verificar Web Push no dispositivo da Isabele.

Não executar merge/deploy automático neste PR. Não há migração SQL; usa as tabelas de controle e outbox já instaladas.
