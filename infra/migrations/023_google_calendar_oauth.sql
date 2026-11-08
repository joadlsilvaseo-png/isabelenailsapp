BEGIN;

-- Configuracao OAuth Google Calendar: tabelas ADITIVAS, sem operacoes de agenda.
-- Aplicar somente na implantacao controlada, com API desativada por flag.
CREATE TABLE IF NOT EXISTS public.google_calendar_oauth_states (
    state_hash CHAR(64) PRIMARY KEY,
    admin_uid TEXT NOT NULL,
    verifier_encrypted TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_oauth_states_expiracao
  ON public.google_calendar_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS public.google_calendar_oauth_credentials (
    connection_name TEXT PRIMARY KEY CHECK (connection_name = 'isabele'),
    google_email TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    connected_by_uid TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
