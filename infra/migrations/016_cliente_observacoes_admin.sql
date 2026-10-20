BEGIN;

-- As notas ficam fora de clientes/{uid}; clientes podem ler o próprio perfil,
-- portanto não devem receber acesso a campos administrativos privados.
CREATE TABLE IF NOT EXISTS public.cliente_observacoes_admin (
    cliente_uid TEXT PRIMARY KEY,
    nota TEXT NOT NULL DEFAULT '',
    updated_by_uid TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cliente_observacoes_admin_nota_check
        CHECK (char_length(nota) <= 3000)
);

COMMIT;
