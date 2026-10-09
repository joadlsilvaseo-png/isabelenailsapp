-- =====================================================
-- ISABELE MARIANA NAILS
-- MONITORAMENTO DE AGENDAMENTOS PARA WEB PUSH
-- =====================================================

CREATE TABLE IF NOT EXISTS public.push_agendamento_estado (
    agendamento_id TEXT PRIMARY KEY,
    cliente_id TEXT,
    status TEXT NOT NULL,
    data_agendamento TEXT,
    horario TEXT,
    servico TEXT,
    reagendado_por TEXT,
    versao INTEGER NOT NULL DEFAULT 1,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.push_entregas (
    id BIGSERIAL PRIMARY KEY,
    chave_evento TEXT NOT NULL UNIQUE,
    agendamento_id TEXT NOT NULL,
    destinatario_uid TEXT NOT NULL,
    tipo TEXT NOT NULL,
    titulo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    destino TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendente',
    tentativas INTEGER NOT NULL DEFAULT 0,
    proxima_tentativa TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    enviado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_entregas_pendentes
ON public.push_entregas (proxima_tentativa, id)
WHERE estado = 'pendente';

CREATE INDEX IF NOT EXISTS idx_push_entregas_destinatario
ON public.push_entregas (destinatario_uid);

-- Marca quando os agendamentos antigos já foram importados.
-- Isso impede notificações em massa no primeiro funcionamento.

CREATE TABLE IF NOT EXISTS public.push_controle (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Permite recuperar notificações que estavam sendo
-- processadas caso o servidor reinicie.

ALTER TABLE public.push_entregas
ADD COLUMN IF NOT EXISTS reservado_em TIMESTAMPTZ;