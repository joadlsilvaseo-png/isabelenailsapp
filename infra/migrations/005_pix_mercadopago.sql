-- Configuracao do sinal
CREATE TABLE IF NOT EXISTS public.pix_configuracao (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    ativo BOOLEAN NOT NULL DEFAULT FALSE,
    percentual_padrao NUMERIC(5,2)
        CHECK (percentual_padrao > 0 AND percentual_padrao <= 100),
    reserva_minutos INTEGER NOT NULL DEFAULT 15
        CHECK (reserva_minutos BETWEEN 5 AND 60),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.pix_configuracao (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Cobrancas de sinal
CREATE TABLE IF NOT EXISTS public.pix_cobrancas (
    id UUID PRIMARY KEY,
    cliente_uid TEXT NOT NULL,
    agendamento_id TEXT,
    reserva_dados JSONB NOT NULL DEFAULT '{}'::jsonb,
    referencia_externa TEXT NOT NULL UNIQUE,
    chave_idempotencia UUID NOT NULL UNIQUE,
    mp_order_id TEXT UNIQUE,
    valor_total_centavos BIGINT NOT NULL
        CHECK (valor_total_centavos > 0),
    percentual_sinal NUMERIC(5,2) NOT NULL
        CHECK (percentual_sinal > 0 AND percentual_sinal <= 100),
    valor_sinal_centavos BIGINT NOT NULL
        CHECK (valor_sinal_centavos > 0),
    valor_restante_centavos BIGINT NOT NULL
        CHECK (valor_restante_centavos >= 0),
    estado TEXT NOT NULL DEFAULT 'criada'
        CHECK (estado IN (
            'criada', 'pendente', 'paga',
            'expirada', 'cancelada', 'estornada', 'falha'
        )),
    vence_em TIMESTAMPTZ,
    pago_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (valor_sinal_centavos <= valor_total_centavos),
    CHECK (
        valor_restante_centavos =
        valor_total_centavos - valor_sinal_centavos
    )
);

CREATE INDEX IF NOT EXISTS idx_pix_cobrancas_cliente
ON public.pix_cobrancas (cliente_uid, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_pix_cobrancas_estado
ON public.pix_cobrancas (estado, vence_em);

-- Historico dos eventos financeiros recebidos
CREATE TABLE IF NOT EXISTS public.pix_eventos (
    id BIGSERIAL PRIMARY KEY,
    cobranca_id UUID REFERENCES public.pix_cobrancas(id),
    chave_evento TEXT UNIQUE,
    tipo TEXT NOT NULL,
    mp_order_id TEXT,
    recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);