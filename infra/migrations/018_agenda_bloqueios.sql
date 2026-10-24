BEGIN;

-- Bloqueios exclusivamente operacionais: não criam agendamentos, cobranças,
-- notificações nem eventos do Google Calendar.
CREATE TABLE IF NOT EXISTS public.agenda_bloqueios (
  data_servico DATE NOT NULL,
  inicio_minuto INTEGER NOT NULL,
  fim_minuto INTEGER NOT NULL,
  alterado_por_uid TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (data_servico, inicio_minuto),
  CONSTRAINT agenda_bloqueio_intervalo CHECK (
    inicio_minuto >= 0 AND inicio_minuto < 1440
    AND inicio_minuto % 30 = 0 AND fim_minuto = inicio_minuto + 30
    AND fim_minuto <= 1440
  ),
  CONSTRAINT agenda_bloqueio_uid CHECK (alterado_por_uid ~ '^[A-Za-z0-9_-]{1,128}$')
);

COMMIT;
