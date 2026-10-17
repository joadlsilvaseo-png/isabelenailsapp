BEGIN;

-- Agenda local e recuperável de polling; não altera estados nem histórico financeiro.
ALTER TABLE public.pix_cobrancas
    ADD COLUMN IF NOT EXISTS pix_polling_next_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pix_polling_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS pix_polling_lease_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pix_polling_last_error TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pix_cobrancas_polling_attempts_check'
          AND conrelid = 'public.pix_cobrancas'::regclass
    ) THEN
        ALTER TABLE public.pix_cobrancas
            ADD CONSTRAINT pix_cobrancas_polling_attempts_check
            CHECK (pix_polling_attempts >= 0);
    END IF;
END
$$;

-- Só retoma Orders ainda pendentes e recentes. Cobranças antigas não entram
-- na fila na primeira ativação; o horizonte inicial é de 72 horas.
UPDATE public.pix_cobrancas
SET pix_polling_next_at = NOW()
WHERE mp_order_id IS NOT NULL
  AND estado = 'pendente'
  AND criado_em >= NOW() - INTERVAL '72 hours'
  AND pix_polling_next_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_pix_cobrancas_polling_due
    ON public.pix_cobrancas (mp_environment, pix_polling_next_at, criado_em)
    WHERE mp_order_id IS NOT NULL
      AND pix_polling_next_at IS NOT NULL
      AND estado IN ('pendente', 'paga');

-- Janela móvel global de consultas autenticadas, compartilhada entre API e worker.
CREATE TABLE IF NOT EXISTS public.pix_polling_request_budget (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0)
);

INSERT INTO public.pix_polling_request_budget (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
