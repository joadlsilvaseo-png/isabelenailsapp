# Plano de isolamento e recuperação — agenda com grade nativa de 15 minutos

## Estado inicial verificado
- Branch `main` (não modificar durante o desenvolvimento): `94809f76f9cb9d7f4b2b39d802bf46c281830993`.
- Branch de desenvolvimento: `feat/agenda-grade-15min-isolada`.
- **Não houve acesso nem alteração à VPS de produção nesta etapa.**
- Esta documentação não é um backup de banco, Docker ou servidor.

## Invariantes obrigatórios
1. Os horários e dados de agendamentos confirmados não podem ser reescritos ou deslocados.
2. PIX: preservar cobrança, confirmação, expiração, conciliação, isenções, idempotência e notificações.
3. Calendar: manter identidade dos eventos; horários de término continuam sendo início + duração real.
4. Regra comercial: buffer de 15 min apenas *entre atendimentos*; nunca somar buffer à duração/cobrança/evento.
5. Bloqueio manual: sobreposição literal, sem buffer ao redor do bloqueio.
6. Validar dados reais PG + Firestore sob lock por data, mantendo prevenção a concorrência.
7. Data fechada, expediente e restrição de serviços de dezembro seguem válidos.
8. Não migrar ou reescrever reservas históricas, nem aplicar schema sem revisão.

## Mudanças projetadas na branch
- Resolução nativa de início: múltiplos de 15 min.
- Fim do antigo requisito de dois agendamentos para horários :15/:45.
- Regras semanais: definir janelas comerciais contínuas em vez de whitelist estática de inícios :00/:30.
- Validar duração + buffer + bloqueios + limite de expediente para cada início.
- Front: carrosséis independentes de manhã, tarde e noite, com botões disponíveis e indisponíveis.
- Gestão de bloqueios administrativos pode continuar em quadrículas de 30min nesta primeira etapa:
  intervalos de bloqueio já funcionam independentemente da grade pública de 15 min.
  A eventual granularidade de bloqueio de 15min será uma mudança administrativa separada.

## Limites comerciais sujeitos a validação pela profissional
- Terça 14h–17h30; quarta 09h–12h30 e 14h–17h30 (janela original).
- Quinta 11h–21h; sexta 09h–21h.
- Sábado 09h–18h, mantendo a exceção existente de início às 16h e duração 150 min até 18h30.
- Domingo e segunda sem expediente semanal, salvo datas especiais de dezembro.
- Dezembro 2026: manter exceções de datas e categorias já implantadas.

**Atenção:** horários adicionados dentro das janelas, inclusive 15 minutos antes do fim para serviços curtos, devem ser testados e aprovados antes do deploy. Nenhum comportamento de produção deve mudar apenas com o commit de branch.

## Proteção e rollback
1. Sem merge/deploy, produção permanece na versão acima: não precisa de rollback.
2. Antes de **qualquer** deploy futuro, coletar confirmação de:
   - `git rev-parse HEAD` no diretório da VPS;
   - versão/imagem exata do container de API que está rodando;
   - snapshots e backups do PostgreSQL, com teste de restauração em ambiente isolado;
   - cópia segura das configurações do Docker/Caddy e variáveis de ambiente **fora do Git**;
   - saúde da API, flags de produção e integridade dos workers PIX/Calendar.
3. Rodar testes locais, PostgreSQL17, testes de integração, QA mobile, preview frontend e ambiente isolado.
4. Ter roteiro reversível de aplicação da imagem anterior e **não restaurar banco de produção com dump antigo** sem analisar movimentações ocorridas depois.
5. Aprovação explícita separada para merge e deploy.

## Critérios de aceite
- Seleção e confirmação de inícios :00/:15/:30/:45 para serviços de 30/60/90/120/150 min.
- Serviços sequenciais com exatamente 15 min sem sobreposição.
- O intervalo próximo ao fim do expediente não oferece serviço que ultrapasse o fechamento.
- Bloqueios e reservas PIX pendentes prevalecem.
- O backend não aceita início exibido apenas pelo frontend e rejeita corrida concorrente.
- Reagendamento com PIX pago, isenção, alteração de serviço e sincronização Calendar preservados.
- Carrosséis com navegação acessível por toque, teclas e controles visíveis.
