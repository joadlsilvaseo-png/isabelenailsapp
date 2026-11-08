BEGIN;

-- Fase operacional: fencing token persistente. Evita que um worker antigo
-- conclua uma intencao cujo lease passou a outro processo.
-- NAO cria workers nem altera eventos. Migracao aditiva, sem backfill.
ALTER TABLE public.google_calendar_sync_operations
  ADD COLUMN IF NOT EXISTS lease_token UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.google_calendar_sync_operations'::regclass
      AND conname = 'google_calendar_operacoes_lease_token_check'
  ) THEN
    ALTER TABLE public.google_calendar_sync_operations
      ADD CONSTRAINT google_calendar_operacoes_lease_token_check
      CHECK (estado <> 'processando' OR lease_token IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_google_calendar_lease_token
  ON public.google_calendar_sync_operations(lease_token)
  WHERE estado IN ('processando','aguardando_confirmacao');

COMMIT;
