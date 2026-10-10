-- Toda cobranca conserva o ambiente em que o pedido foi criado.
-- Registros existentes eram exclusivamente de teste.
ALTER TABLE public.pix_cobrancas
    ADD COLUMN IF NOT EXISTS mp_environment TEXT NOT NULL DEFAULT 'test';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'pix_cobrancas_mp_environment_check'
          AND conrelid = 'public.pix_cobrancas'::regclass
    ) THEN
        ALTER TABLE public.pix_cobrancas
            ADD CONSTRAINT pix_cobrancas_mp_environment_check
            CHECK (mp_environment IN ('test', 'production'));
    END IF;
END
$$;

-- Outbox durável: somente informações necessárias para criar o evento.
CREATE TABLE IF NOT EXISTS public.pix_calendar_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    agendamento_id TEXT NOT NULL UNIQUE,
    nome_cliente TEXT NOT NULL,
    servico TEXT NOT NULL,
    data_servico DATE NOT NULL,
    horario TIME NOT NULL,
    duracao_minutos INTEGER NOT NULL CHECK (duracao_minutos > 0),
    status TEXT NOT NULL DEFAULT 'pendente'
        CHECK (status IN ('pendente', 'enviando', 'enviado')),
    tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
    proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bloqueado_ate TIMESTAMPTZ,
    ultimo_erro TEXT,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    enviado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pix_calendar_outbox_pendente
    ON public.pix_calendar_outbox (proxima_tentativa_em, criado_em)
    WHERE status = 'pendente';

CREATE INDEX IF NOT EXISTS idx_pix_calendar_outbox_lease
    ON public.pix_calendar_outbox (bloqueado_ate)
    WHERE status = 'enviando';
