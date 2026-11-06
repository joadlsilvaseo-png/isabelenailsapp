-- Classificador conservador da migração 022 (executado em modo somente leitura).
-- pending: tabela ausente ou constraint 018 legada.
-- applied: check 15/30 e exclusão GiST presentes.
-- partial: configuração inesperada -> abortar a publicação.
WITH estados AS (
  SELECT
    to_regclass('public.agenda_bloqueios') AS tabela,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agenda_bloqueios')
        AND conname = 'agenda_bloqueios_sem_sobreposicao'
        AND contype = 'x'
        AND pg_get_constraintdef(oid) LIKE '%int4range%'
    ) AS exclusao_15,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agenda_bloqueios')
        AND contype = 'x'
    ) AS existe_exclusao,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agenda_bloqueios')
        AND conname = 'agenda_bloqueio_intervalo' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%inicio_minuto % 15%'
        AND pg_get_constraintdef(oid) LIKE '%fim_minuto = (inicio_minuto + 15)%'
    ) AS check_15,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('public.agenda_bloqueios')
        AND conname = 'agenda_bloqueio_intervalo' AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%inicio_minuto % 30%'
        AND pg_get_constraintdef(oid) LIKE '%fim_minuto = (inicio_minuto + 30)%'
    ) AS check_30
)
SELECT CASE
  WHEN tabela IS NULL THEN 'pending'
  WHEN exclusao_15 AND check_15 THEN 'applied'
  WHEN NOT existe_exclusao AND check_30 AND NOT check_15 THEN 'pending'
  ELSE 'partial'
END FROM estados;
