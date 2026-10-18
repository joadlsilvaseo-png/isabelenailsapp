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
-- Somente historicos cancelados, nunca tentados pelo worker, sem envio.
UPDATE public.agendamento_cancelamentos AS c
SET calendar_estado = 'dispensado',
    calendar_bloqueado_ate = NULL,
    calendar_ultimo_erro = NULL,
    atualizado_em = NOW()
FROM public.pix_calendar_outbox AS o
WHERE o.agendamento_id = c.agendamento_id
  AND o.event_id = c.calendar_event_id
  AND c.estado = 'concluida'
  AND c.calendar_estado = 'pendente'
  AND o.status IN ('pendente', 'dispensado')
  AND o.tentativas = 0
  AND o.enviado_em IS NULL;

UPDATE public.pix_calendar_outbox AS o
SET status = 'dispensado',
    bloqueado_ate = NULL,
    atualizado_em = NOW()
FROM public.agendamento_cancelamentos AS c
WHERE o.agendamento_id = c.agendamento_id
  AND o.event_id = c.calendar_event_id
  AND c.estado = 'concluida'
  AND c.calendar_estado = 'dispensado'
  AND o.status = 'pendente'
  AND o.tentativas = 0
  AND o.enviado_em IS NULL;

COMMIT;
