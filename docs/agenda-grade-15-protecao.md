# Plano de proteção — Agenda nativa de 15 minutos (NÃO PUBLICAR)

## Estado de referência

- Código de produção confirmado: `94809f76f9cb9d7f4b2b39d802bf46c281830993`.
- Branch de recuperação Git: `safety/pre-grade-15min-94809f7`.
- Branch de desenvolvimento: `feat/agenda-nativa-15min`.
- Este documento e as alterações **não representam um backup executado na VPS**.
- **Não fazer merge/deploy** antes de validar CI, ambiente isolado e rollback.

## Invariantes obrigatórias

1. Backend PIX: sem alterações em Orders, webhook, conciliação, outbox, preço, sinal, isenção, vencimento e idempotência.
2. Reservas vigentes não são transformadas nem deslocadas automaticamente.
3. Conflitos de reservas no PostgreSQL, Firestore e bloqueios administrativos continuam sujeitos à mesma margem de 15 min entre atendimentos.
4. Especial de dezembro, proibição de serviços, cancelamento, reagendamento, alteração de serviço e sincronização Calendar continuam obrigatórios.
5. Grade pública usa :00, :15, :30 e :45; validação por duração real e por janelas do expediente.
6. Não transformar silenciosamente bloqueios administrativos antigos de 30 min em 15 min. Uma eventual migração deve ser planejada/testada à parte.
7. Preview de frontend **não deve ser usado para criar PIX ou reserva real**. Produção só depois de backend e frontend estarem na mesma revisão.

## Backups pendentes (executar na VPS com acesso autorizado, ANTES de deploy)

A execução na VPS é independente desta alteração de código; por segurança, não armazenar dumps de banco, .env ou credenciais no Git.

1. Registrar IDs de imagens Docker atualmente em execução e o SHA do checkout da VPS.
2. Salvar cópia verificada do dump PostgreSQL com `pg_dump --format=custom` em diretório privado do host.
3. Verificar o arquivo com `pg_restore --list` e testar a restauração em instância temporária, sem tocar no banco Isabele de produção.
4. Registrar volume de dados, opções de rede e estado dos containers, sem revelar segredos.
5. Planejar recuperação do código/containers por tag de imagem anterior e procedimentos distintos para banco de dados. Banco NÃO deve ser restaurado automaticamente ao reverter código.
6. Não reverter a VPS se nenhum deploy chegou a ocorrer. A branch de teste, sozinha, não altera a API de produção.

## Pendências para aceitação

- [ ] Execução completa de `npm test` com todas as suites.
- [ ] Testes integrados contra banco PostgreSQL 17 e Firestore de teste.
- [ ] Fluxo PIX real validado em sandbox, sem cobrança em produção.
- [ ] Teste de bloqueios administrativos existentes de 30 min sobre a nova grade de 15 min.
- [ ] Reagendamento PIX pago, isenção, alteração de serviço e Google Calendar de teste.
- [ ] Carrossel em Android/iPhone, foco por teclado e leitor de tela.
- [ ] Backup operacional verificado na VPS.
- [ ] Aprovação do usuário para merge e deploy em etapas.

