BEGIN;

CREATE TABLE public.pix_webhook_inbox (
    mp_order_id TEXT PRIMARY KEY,
    ultima_notificacao_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
    processado_em TIMESTAMPTZ,
    ultimo_erro TEXT
);

CREATE INDEX idx_pix_webhook_pendentes
ON public.pix_webhook_inbox (proxima_tentativa_em)
WHERE processado_em IS NULL;

COMMIT;