BEGIN;

-- A mesma outbox de Web Push agenda os lembretes, com chave única por
-- agendamento, versão, tipo e cliente. proxima_tentativa continua sendo o
-- relógio já usado pelo pushWorker.
ALTER TABLE public.push_entregas
  ADD COLUMN IF NOT EXISTS agendado_para TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agendamento_versao INTEGER;

CREATE INDEX IF NOT EXISTS idx_push_entregas_lembretes_pendentes
  ON public.push_entregas (proxima_tentativa, id)
  WHERE estado = 'pendente'
    AND tipo IN ('lembrete_24h', 'lembrete_1h');

COMMIT;
