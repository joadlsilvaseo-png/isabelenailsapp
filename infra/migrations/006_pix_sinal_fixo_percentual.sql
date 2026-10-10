BEGIN;

-- Configuracao global: valor fixo ou percentual.
ALTER TABLE public.pix_configuracao
    ADD COLUMN IF NOT EXISTS tipo_sinal_padrao TEXT NOT NULL DEFAULT 'percentual',
    ADD COLUMN IF NOT EXISTS valor_fixo_padrao_centavos BIGINT;

-- R$ 20,00 como valor inicial, se ainda nao houver percentual definido.
UPDATE public.pix_configuracao
SET
    tipo_sinal_padrao = 'fixo',
    valor_fixo_padrao_centavos = 2000
WHERE id = 1
  AND percentual_padrao IS NULL
  AND valor_fixo_padrao_centavos IS NULL;

ALTER TABLE public.pix_configuracao
    ALTER COLUMN tipo_sinal_padrao SET DEFAULT 'fixo';

-- Cada cobranca registra o tipo e valor configurado no momento da criacao.
ALTER TABLE public.pix_cobrancas
    ADD COLUMN IF NOT EXISTS tipo_sinal TEXT NOT NULL DEFAULT 'percentual',
    ADD COLUMN IF NOT EXISTS valor_fixo_configurado_centavos BIGINT;

-- Percentual passa a ser opcional para cobrancas de valor fixo.
ALTER TABLE public.pix_cobrancas
    ALTER COLUMN percentual_sinal DROP NOT NULL,
    ALTER COLUMN tipo_sinal DROP DEFAULT;

-- Validacoes dos dois formatos.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_pix_configuracao_tipo_sinal'
          AND conrelid = 'public.pix_configuracao'::regclass
    ) THEN
        ALTER TABLE public.pix_configuracao
        ADD CONSTRAINT chk_pix_configuracao_tipo_sinal
        CHECK (
            (
                tipo_sinal_padrao = 'fixo'
                AND valor_fixo_padrao_centavos > 0
                AND percentual_padrao IS NULL
            )
            OR
            (
                tipo_sinal_padrao = 'percentual'
                AND percentual_padrao > 0
                AND percentual_padrao <= 100
                AND valor_fixo_padrao_centavos IS NULL
            )
        );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_pix_cobrancas_tipo_sinal'
          AND conrelid = 'public.pix_cobrancas'::regclass
    ) THEN
        ALTER TABLE public.pix_cobrancas
        ADD CONSTRAINT chk_pix_cobrancas_tipo_sinal
        CHECK (
            (
                tipo_sinal = 'percentual'
                AND percentual_sinal IS NOT NULL
                AND valor_fixo_configurado_centavos IS NULL
            )
            OR
            (
                tipo_sinal = 'fixo'
                AND percentual_sinal IS NULL
                AND valor_fixo_configurado_centavos > 0
                AND valor_fixo_configurado_centavos = valor_sinal_centavos
            )
        );
    END IF;
END
$$;

COMMIT;