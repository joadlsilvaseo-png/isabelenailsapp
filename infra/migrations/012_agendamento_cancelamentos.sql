BEGIN;

-- Saga durável para o cancelamento: registra a intenção antes de alterar
-- Firestore e permite concluir a liberação da reserva após falhas parciais.
CREATE TABLE IF NOT EXISTS public.agendamento_cancelamentos (
    agendamento_id TEXT PRIMARY KEY,
    cobranca_id UUID REFERENCES public.pix_cobrancas(id),
    cliente_uid TEXT NOT NULL,
    solicitante_uid TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('cliente', 'profissional')),
    estado TEXT NOT NULL DEFAULT 'solicitada'
        CHECK (estado IN ('solicitada', 'concluida', 'falha_permanente')),
    calendar_event_id TEXT,
    calendar_estado TEXT NOT NULL DEFAULT 'dispensado'
        CHECK (calendar_estado IN ('dispensado', 'pendente', 'enviando', 'enviado')),
    calendar_tentativas INTEGER NOT NULL DEFAULT 0 CHECK (calendar_tentativas >= 0),
    calendar_proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    calendar_bloqueado_ate TIMESTAMPTZ,
    calendar_ultimo_erro TEXT,
    calendar_enviado_em TIMESTAMPTZ,
    tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
    proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bloqueado_ate TIMESTAMPTZ,
    ultimo_erro TEXT,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    concluido_em TIMESTAMPTZ,
    CHECK (
        (calendar_event_id IS NULL AND calendar_estado = 'dispensado') OR
        (calendar_event_id IS NOT NULL AND calendar_estado <> 'dispensado')
    )
);

CREATE INDEX IF NOT EXISTS idx_agendamento_cancelamentos_pendentes
    ON public.agendamento_cancelamentos (proxima_tentativa_em, criado_em)
    WHERE estado = 'solicitada';

CREATE INDEX IF NOT EXISTS idx_agendamento_cancelamentos_calendar_pendente
    ON public.agendamento_cancelamentos (calendar_proxima_tentativa_em, criado_em)
    WHERE calendar_estado IN ('pendente', 'enviando');

COMMIT;
