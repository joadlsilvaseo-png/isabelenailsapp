ALTER TABLE public.push_entregas
ADD COLUMN IF NOT EXISTS lida_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_push_entregas_central_nao_lidas
ON public.push_entregas (destinatario_uid, criado_em DESC)
WHERE lida_em IS NULL;