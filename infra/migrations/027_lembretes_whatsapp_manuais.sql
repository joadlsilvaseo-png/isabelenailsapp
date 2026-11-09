-- Marcacao manual de lembretes enviados pelo WhatsApp Business.
-- Nenhuma mensagem e enviada pela API. Preserva o historico por versao do agendamento.
BEGIN;

CREATE TABLE IF NOT EXISTS public.lembretes_whatsapp_manuais (
  agendamento_id TEXT NOT NULL CHECK (agendamento_id ~ '^[A-Za-z0-9_-]{1,160}$'),
  assinatura CHAR(64) NOT NULL CHECK (assinatura ~ '^[a-f0-9]{64}$'),
  data_servico DATE NOT NULL,
  marcado_por_uid TEXT NOT NULL CHECK (marcado_por_uid ~ '^[A-Za-z0-9_-]{1,128}$'),
  marcado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agendamento_id, assinatura)
);

CREATE INDEX IF NOT EXISTS idx_lembretes_whatsapp_data
  ON public.lembretes_whatsapp_manuais (data_servico);

COMMIT;
