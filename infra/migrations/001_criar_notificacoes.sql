CREATE TABLE IF NOT EXISTS public.notificacoes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    firebase_uid TEXT NOT NULL,
    tipo VARCHAR(50) NOT NULL,
    titulo VARCHAR(180) NOT NULL,
    mensagem TEXT NOT NULL,
    agendamento_id TEXT,
    lida_em TIMESTAMPTZ,
    criada_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notificacoes_usuario
ON public.notificacoes (firebase_uid, criada_em DESC);