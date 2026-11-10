# Lembretes de amanha — WhatsApp Business manual

## Escopo

O Assistente Isabele da tela principal (acesso somente admin) exibe um card com
quantidade de lembretes pendentes. Ao clicar, abre um modal (na mesma tela) com
os atendimentos ATIVOS do dia seguinte, com horario no fuso \`America/Sao_Paulo\`.

O botao **Abrir WhatsApp** apenas abre um link \`wa.me\` com texto preparado.
A profissional precisa ENVIAR a mensagem no WhatsApp Business e entao tocar em
**Ja enviei · Marcar enviado**. Essa marcacao e administrativa, **nao prova
entrega nem leitura**. Nao ha bot, API comercial, disparos automaticos ou custos
por mensagem na arquitetura implementada.

## Privacidade e seguranca

- API \`GET /api/admin/lembretes-amanha\`; \`POST/DELETE /api/admin/lembretes-amanha/marcacao\`.
- Token Firebase verificado no backend e papel \`role=admin, ativo=true\`.
- Telefone so e retornado para profissional autenticada. Sem cache HTTP.
- Requer consentimento da cliente para lembretes via WhatsApp; cadastro de telefone
  por si so nao comprova autorizacao.
- Se cliente nao tem telefone valido, aparece a indicacao no modal; nao ha link de envio.
- A API nao altera Firestore, reservas, PIX, Google Calendar ou notificacoes Push.

## Idempotencia e atualizacao de dados

Os status manuais sao persistidos apenas na tabela PostgreSQL
\`public.lembretes_whatsapp_manuais\`. A chave combina ID do agendamento e
uma assinatura SHA-256 de identidade, data, horario, servico, duracao e telefone.
Ao reagendar, trocar o servico ou mudar o telefone, a assinatura anterior deixa
de ser considerada e o lembrete reaparece como pendente. Cancelamentos deixam
de aparecer, pois a API so inclui status \`agendado\`, \`confirmado\` ou
\`reagendado\`. O POST e DELETE revalidam a informacao mais recente do Firestore
antes de registrar/desfazer a marcacao.

## Implantacao — ordem obrigatoria

1. Validar PR e testes automatizados da branch
   \`feat/assistente-lembretes-whatsapp-20261109\`.
2. Garantir backup e executar a migracao aditiva
   \`infra/migrations/027_lembretes_whatsapp_manuais.sql\` uma unica vez
   na VPS (o script possui \`CREATE TABLE/INDEX IF NOT EXISTS\`).
3. Gerar e publicar backend completo da mesma revisao com o novo endpoint.
   Validar GET autenticado admin (200) e cliente (403).
4. Publicar frontend com \`principal.html\`, \`principal.js\`,
   \`assistenteGestaoUI.js\`, \`assistenteLembretesWhatsappUI.js\` e
   \`assistenteGestao.css\`; o card nao deve ser ativado antes da API.
5. Como admin, simular abertura de modal, envio manual, marcacao e desfazer;
   alterar horario/servico e verificar retorno de pendencia; cancelar e verificar
   desaparecimento. Validar ausencia da interface para cliente.
6. Confirmar que o PWA atualiza os arquivos versionados corretamente no iPhone
   e no Android sem mexer em flags de PIX/Google Calendar.

Esta PR esta empilhada sobre a PR #56, que ainda aguarda consolidacao em
\`main\`. Nunca atualizar a VPS usando apenas a \`main\` desatualizada.

## Falhas/rollback

O erro de leitura da nova API deve exibir **Indisponivel**, sem indicar
falsamente zero lembretes, sem afetar as outras funcionalidades do Assistente.
Se o frontend for revertido, a tabela nova pode permanecer para preservar
historico de marcacoes; **nao excluir tabelas automaticamente**.
