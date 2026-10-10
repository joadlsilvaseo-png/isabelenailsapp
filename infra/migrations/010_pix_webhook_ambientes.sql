BEGIN;

ALTER TABLE public.pix_webhook_inbox
    ADD COLUMN IF NOT EXISTS mp_environment TEXT NOT NULL DEFAULT 'test';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pix_webhook_inbox_environment_check'
          AND conrelid = 'public.pix_webhook_inbox'::regclass
    ) THEN
        ALTER TABLE public.pix_webhook_inbox
            ADD CONSTRAINT pix_webhook_inbox_environment_check
            CHECK (mp_environment IN ('test', 'production'));
    END IF;
END
$$;

ALTER TABLE public.pix_webhook_inbox
    DROP CONSTRAINT IF EXISTS pix_webhook_inbox_pkey;
ALTER TABLE public.pix_webhook_inbox
    ADD CONSTRAINT pix_webhook_inbox_pkey
    PRIMARY KEY (mp_environment, mp_order_id);

DROP INDEX IF EXISTS public.idx_pix_webhook_pendentes;
CREATE INDEX idx_pix_webhook_pendentes
    ON public.pix_webhook_inbox (mp_environment, proxima_tentativa_em)
    WHERE processado_em IS NULL;

COMMIT;
