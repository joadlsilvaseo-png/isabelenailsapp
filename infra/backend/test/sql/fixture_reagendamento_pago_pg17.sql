-- PostgreSQL 17 temporário do CI; nenhuma tabela real da VPS.
CREATE TABLE public.pix_cobrancas (
  id UUID PRIMARY KEY,
  cliente_uid TEXT NOT NULL,
  agendamento_id TEXT,
  estado TEXT NOT NULL
);

CREATE TABLE public.pix_calendar_outbox (
  event_id TEXT PRIMARY KEY,
  agendamento_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
);

CREATE TABLE public.agenda_bloqueios (
  data_servico DATE NOT NULL,
  inicio_minuto SMALLINT NOT NULL,
  fim_minuto SMALLINT NOT NULL
);

CREATE TABLE public.agendamento_cancelamentos (
  agendamento_id TEXT PRIMARY KEY,
  estado TEXT NOT NULL
);
