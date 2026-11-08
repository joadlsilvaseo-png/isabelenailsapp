BEGIN;

-- FASE OPERACIONAL (preparo, NAO executada na VPS).
-- Token de posse para evitar que worker antigo finalize operacao que perdeu
-- o lease. Aplica-se SOMENTE à nova fila da migracao 024, nunca às sagas PIX.
ALTER TABLE public.google_calendar_sync_operations
  ADD COLUMN IF NOT EXISTS lease_token UUID;

DO $safe$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.google_calendar_sync_operations'::regclass
      AND conname = 'google_calendar_operacoes_lease_consistente'
  ) THEN
    ALTER TABLE public.google_calendar_sync_operations
      ADD CONSTRAINT google_calendar_operacoes_lease_consistente
      CHECK (
        (estado = 'processando'
          AND lease_token IS NOT NULL
          AND bloqueado_ate IS NOT NULL)
        OR
        (estado <> 'processando' AND lease_token IS NULL)
      );
  END IF;
END
$safe$;

COMMIT;
