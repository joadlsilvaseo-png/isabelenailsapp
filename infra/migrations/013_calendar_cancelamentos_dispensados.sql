BEGIN;

-- Permite apos um cancelamento concluido descartar a criacao de Calendar
-- que nao chegou a ser entregue. Mantem a linha como historico/idempotencia.
ALTER TABLE public.pix_calendar_outbox
    DROP CONSTRAINT IF EXISTS pix_calendar_outbox_status_check;

ALTER TABLE public.pix_calendar_outbox
    ADD CONSTRAINT pix_calendar_outbox_status_check
    CHECK (status IN ('pendente', 'enviando', 'enviado', 'dispensado'));

COMMIT;
