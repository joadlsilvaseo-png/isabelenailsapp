BEGIN;

-- Estado terminal para criacoes do Calendar dispensadas por cancelamento.
ALTER TABLE public.pix_calendar_outbox
  DROP CONSTRAINT IF EXISTS pix_calendar_outbox_status_check;
ALTER TABLE public.pix_calendar_outbox
  ADD CONSTRAINT pix_calendar_outbox_status_check
  CHECK (status IN ('pendente', 'enviando', 'enviado', 'dispensado'));

COMMIT;
