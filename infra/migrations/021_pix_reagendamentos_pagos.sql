BEGIN;

-- Operações idempotentes de reagendamento de sinal PIX já pago.
-- A reserva original continua vinculada à MESMA cobrança.
CREATE TABLE IF NOT EXISTS public.pix_reagendamentos_pagos (
  operation_id UUID PRIMARY KEY,
  agendamento_id TEXT NOT NULL,
  solicitante_uid TEXT NOT NULL,
  cliente_uid TEXT NOT NULL,
  servico_id TEXT NOT NULL,
  reserva_id UUID NOT NULL REFERENCES public.pix_reservas(id),
  cobranca_id UUID NOT NULL REFERENCES public.pix_cobrancas(id),
  calendar_event_id TEXT NOT NULL,
  nome_cliente TEXT NOT NULL,
  servico_nome TEXT NOT NULL,
  observacoes TEXT NOT NULL DEFAULT '',
  origem_data DATE NOT NULL,
  origem_inicio SMALLINT NOT NULL,
  origem_fim SMALLINT NOT NULL,
  destino_data DATE NOT NULL,
  destino_inicio SMALLINT NOT NULL,
  destino_fim SMALLINT NOT NULL,
  hold_reserva_id UUID REFERENCES public.pix_reservas(id),
  estado TEXT NOT NULL DEFAULT 'solicitada'
    CHECK (estado IN ('solicitada', 'calendar_enviado', 'concluida')),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bloqueado_ate TIMESTAMPTZ,
  limpeza_pendente BOOLEAN NOT NULL DEFAULT TRUE,
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  concluido_em TIMESTAMPTZ,
  CHECK (origem_inicio >= 0 AND origem_fim > origem_inicio AND origem_fim <= 1440),
  CHECK (destino_inicio >= 0 AND destino_fim > destino_inicio AND destino_fim <= 1440)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pix_reagendamento_pago_pendente
ON public.pix_reagendamentos_pagos(agendamento_id)
WHERE estado <> 'concluida';

CREATE INDEX IF NOT EXISTS ix_pix_reagendamento_pago_worker
ON public.pix_reagendamentos_pagos(proxima_tentativa_em, criado_em)
WHERE estado <> 'concluida' OR limpeza_pendente = TRUE;

COMMIT;
