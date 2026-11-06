BEGIN;

-- Migração 022: acrescenta resolução de 15 min SEM modificar as linhas
-- existentes. Os 185 bloqueios legados de 30 min continuam intactos.
DO $$
BEGIN
  IF to_regclass('public.agenda_bloqueios') IS NULL THEN
    RAISE EXCEPTION 'Tabela agenda_bloqueios inexistente (execute 018 antes)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agenda_bloqueios
    WHERE inicio_minuto < 0 OR fim_minuto > 1440
       OR inicio_minuto % 30 <> 0 OR fim_minuto <> inicio_minuto + 30
  ) THEN
    RAISE EXCEPTION 'Bloqueios legados fora do padrão: migração cancelada';
  END IF;
END $$;

-- Novos intervalos de 15 minutos e intervalos legados de 30 minutos
-- coexistem. Nenhum registro é deletado ou dividido na migração.
ALTER TABLE public.agenda_bloqueios
  DROP CONSTRAINT agenda_bloqueio_intervalo;

ALTER TABLE public.agenda_bloqueios
  ADD CONSTRAINT agenda_bloqueio_intervalo CHECK (
    inicio_minuto >= 0 AND inicio_minuto < 1440
    AND inicio_minuto % 15 = 0
    AND fim_minuto <= 1440
    AND (
      fim_minuto = inicio_minuto + 15
      OR (inicio_minuto % 30 = 0 AND fim_minuto = inicio_minuto + 30)
    )
  );

-- Proteção defensiva: não permitir bloqueios 15/30 sobrepostos,
-- mesmo que uma aplicação antiga tente criá-los.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE public.agenda_bloqueios
  ADD CONSTRAINT agenda_bloqueios_sem_sobreposicao
  EXCLUDE USING gist (
    data_servico WITH =,
    int4range(inicio_minuto, fim_minuto, '[)') WITH &&
  );

COMMIT;
