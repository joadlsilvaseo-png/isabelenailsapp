BEGIN;
-- Mantem o event_id historico mesmo para um cancelamento dispensado.
DO $migration$
DECLARE
  nome TEXT;
BEGIN
  SELECT conname INTO STRICT nome
  FROM pg_constraint
  WHERE conrelid = 'public.agendamento_cancelamentos'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%calendar_event_id%'
    AND pg_get_constraintdef(oid) LIKE '%calendar_estado%';
  EXECUTE format('ALTER TABLE public.agendamento_cancelamentos DROP CONSTRAINT %I', nome);
END
$migration$;

ALTER TABLE public.agendamento_cancelamentos
  ADD CONSTRAINT agendamento_cancelamentos_calendar_evento_check
  CHECK (calendar_event_id IS NOT NULL OR calendar_estado = 'dispensado');
COMMIT;
