BEGIN;

-- Fase de transicao: autorizacoes EXPLICITAS para criar eventos de reservas novas.
-- Sem backfill, sem liberacao automatica de reservas historicas, sem triggers.
-- Cada reserva pode ganhar a autorizacao apenas depois de um fluxo futuro
-- comprovar que ela e nova (posterior ao corte), sem possivel evento legado.
CREATE TABLE IF NOT EXISTS public.google_calendar_creation_authorizations (
  agendamento_id TEXT PRIMARY KEY
    CHECK (agendamento_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  calendar_id TEXT NOT NULL
    CHECK (char_length(calendar_id) BETWEEN 1 AND 300 AND calendar_id !~ '[[:space:]]'),
  autorizacao TEXT NOT NULL
    CHECK (autorizacao = 'nova_reserva_verificada'),
  evidencia_sha256 CHAR(64) NOT NULL
    CHECK (evidencia_sha256 ~ '^[a-f0-9]{64}$'),
  autorizado_por TEXT NOT NULL
    CHECK (char_length(autorizado_por) BETWEEN 1 AND 160),
  autorizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumido_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_autorizacoes_nao_consumidas
  ON public.google_calendar_creation_authorizations (calendar_id, autorizado_em)
  WHERE consumido_em IS NULL;

COMMIT;
