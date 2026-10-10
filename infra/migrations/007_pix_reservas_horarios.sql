BEGIN;

-- Suporte a restricoes de sobreposicao no PostgreSQL.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Reservas temporarias de horario para pagamento PIX.
CREATE TABLE public.pix_reservas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    cliente_uid TEXT NOT NULL,
    servico_id TEXT NOT NULL,

    data_servico DATE NOT NULL,

    inicio_minuto SMALLINT NOT NULL,
    fim_minuto SMALLINT NOT NULL,

    estado TEXT NOT NULL DEFAULT 'reservada'
        CHECK (
            estado IN (
                'reservada',
                'confirmada',
                'expirada',
                'cancelada'
            )
        ),

    vence_em TIMESTAMPTZ NOT NULL,

    cobranca_id UUID UNIQUE
        REFERENCES public.pix_cobrancas(id),

    agendamento_id TEXT UNIQUE,

    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        inicio_minuto >= 0
        AND inicio_minuto < 1440
        AND fim_minuto > inicio_minuto
        AND fim_minuto <= 1440
    ),

    -- Impede duas reservas ativas no mesmo periodo.
    CONSTRAINT pix_reservas_sem_sobreposicao
    EXCLUDE USING gist (
        data_servico WITH =,
        int4range(inicio_minuto, fim_minuto, '[)') WITH &&
    )
    WHERE (
        estado IN ('reservada', 'confirmada')
    )
);

CREATE INDEX idx_pix_reservas_vencimento
ON public.pix_reservas (estado, vence_em);

CREATE INDEX idx_pix_reservas_cliente
ON public.pix_reservas (cliente_uid, criado_em DESC);

COMMIT;