BEGIN;

-- A permissão é gravada somente pela API confiável. A chave corresponde ao
-- UID autenticado no Firebase; clientes não recebem acesso direto a esta tabela.
CREATE TABLE IF NOT EXISTS public.cliente_pix_isencoes (
    cliente_uid TEXT PRIMARY KEY,
    ativa BOOLEAN NOT NULL DEFAULT TRUE,
    alterada_por_uid TEXT NOT NULL,
    criada_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizada_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revogada_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cliente_pix_isencoes_ativas
    ON public.cliente_pix_isencoes (cliente_uid)
    WHERE ativa = TRUE;

COMMIT;
