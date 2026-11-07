# Assistente Isabele: Gestão Inteligente (Fase 1)

Escopo: resumo do dia, radar de clientes, mensagens revisadas para WhatsApp e análise semanal, com destaque dinâmico na tela de Gestão.

- Somente frontend. Nenhuma rota ou migração nova, nenhuma mudança em PIX, Calendar, bloqueios ou motor de agendamento.
- Dados: uma leitura da coleção agendamentos e uma leitura da coleção clientes, disponíveis exclusivamente à administradora autorizada.
- Tempo livre: consulta adicional à API já existente /api/pix/disponibilidade, para considerar reservas PIX e bloqueios. Se a consulta falhar, exibir traço e orientação para conferir a agenda.
- Retornos em gel: 21 dias após aplicação concluída, seguindo o mesmo padrão do perfil. Demais serviços: periodicidade derivada de duas visitas concluídas com intervalo entre 14 e 90 dias. Sem agendamento futuro ativo e sem sugerir retornos remotos.
- Mensagens: templates locais, exibidos para revisão e abertura manual do WhatsApp. Nenhuma automação de envio ou IA.
- Semanal: últimos 7 dias contra os 7 anteriores. Valor dos serviços concluídos é estimado a partir do registro do agendamento, não representa dinheiro efetivamente recebido.
- Sem cache persistente de dados pessoais. Sempre conferir a role de admin em usuarios e autenticação da sessão.
- Se falhar a leitura do Firestore, não exibir números fictícios.

Testes: node --test scripts/assistente-gestao-core.test.mjs scripts/assistente-gestao-ui.test.mjs
Validação manual: admin pode ver os cards; cliente não vê; rota PIX indisponível gera campo de tempo livre sem valor; versão mobile e desktop; links de mensagens somente sob clique.