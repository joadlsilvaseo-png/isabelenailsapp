# Proteção dinâmica de início + carrosséis disponíveis

PR de validação (2026-11-07). Não publicar frontend antes de coordenar API da VPS.

## Regra
- Grade permanece de 15 minutos e sem buffer estático.
- Novo agendamento não começa exatamente no término de um atendimento ou reserva existente (14:00–15:00 protege 15:00).
- Próximo horário de 15 minutos permanece livre (15:15), se o serviço couber e não houver outros impedimentos.
- Novo agendamento pode terminar no início de outro compromisso que já estava marcado (15:15–16:00 antes de 16:00–17:00).
- Sequência de serviços da mesma cliente é permitida quando o agendamento anterior está confirmado; nunca se permite sobreposição.
- Bloqueio administrativo não cria intervalo adicional; reservas PIX ativas e pendentes são protegidas.
- Reserva PIX já paga pode ser confirmada sem aplicação retroativa da proteção de início, mantendo checagem de sobreposição.
- Front e backend verificam; backend sempre revalida sob lock PG + Firestore também para inícios :00/:30.
- Horários de expediente, exceções de dezembro, sinal PIX e duração de serviços permanecem inalterados.

## Interface
- Manhã, Tarde e Noite continuam nos mesmos carrosséis com as mesmas setas e estilos.
- Horários disponíveis aparecem por padrão. Ver horários indisponíveis permite visualizar botões desabilitados.
- Cada período informa a quantidade de livres ou que não possui vagas; erro de consulta nunca é tratado como agenda cheia.

## Rollout
- Executar testes automatizados no PR; validar visual mobile na Vercel Preview.
- Validar PIX, isenção, duas reservas simultâneas, reagendamentos, alterações e datas especiais.
- Fazer backup e deploy da API na VPS em procedimento coordenado; validar saúde e rollback.
- Só depois do backend validado, fazer merge do PR na main (Vercel).