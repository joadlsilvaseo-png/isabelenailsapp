BEGIN;

-- Operações idempotentes de troca de serviço com atualização explícita do
-- evento já existente no Calendar. Não altera cobranças nem eventos PIX.
CREATE TABLE IF NOT EXISTS public.agendamento_alteracoes_servico (
  operation_id UUID PRIMARY KEY,
  agendamento_id TEXT NOT NULL,
  admin_uid TEXT NOT NULL,
  cliente_uid TEXT,
  nome_cliente TEXT,
  servico_anterior_id TEXT,
  servico_anterior_nome TEXT,
  servico_novo_id TEXT NOT NULL,
  servico_novo_nome TEXT,
  data_servico DATE,
  inicio_minuto SMALLINT,
  calendar_event_id TEXT,
  duracao_anterior SMALLINT,
  duracao_nova SMALLINT,
  preco_anterior_centavos BIGINT,
  preco_novo_centavos BIGINT,
  sinal_pago_centavos BIGINT NOT NULL DEFAULT 0,
  restante_novo_centavos BIGINT,
  estado TEXT NOT NULL DEFAULT 'solicitada',
  calendar_estado TEXT NOT NULL DEFAULT 'pendente',
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bloqueado_ate TIMESTAMPTZ,
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT agendamento_alteracoes_servico_estado_check
    CHECK (estado IN ('solicitada', 'processando', 'concluida', 'falha_permanente')),
  CONSTRAINT agendamento_alteracoes_servico_calendar_estado_check
    CHECK (calendar_estado IN ('pendente', 'enviando', 'enviado', 'falha')),
  CONSTRAINT agendamento_alteracoes_servico_tentativas_check
    CHECK (tentativas >= 0),
  CONSTRAINT agendamento_alteracoes_servico_inicio_check
    CHECK (inicio_minuto IS NULL OR (inicio_minuto >= 0 AND inicio_minuto < 1440)),
  CONSTRAINT agendamento_alteracoes_servico_duracao_anterior_check
    CHECK (duracao_anterior IS NULL OR duracao_anterior > 0),
  CONSTRAINT agendamento_alteracoes_servico_duracao_nova_check
    CHECK (duracao_nova IS NULL OR duracao_nova > 0),
  CONSTRAINT agendamento_alteracoes_servico_preco_anterior_check
    CHECK (preco_anterior_centavos IS NULL OR preco_anterior_centavos >= 0),
  CONSTRAINT agendamento_alteracoes_servico_preco_novo_check
    CHECK (preco_novo_centavos IS NULL OR preco_novo_centavos > 0),
  CONSTRAINT agendamento_alteracoes_servico_sinal_pago_check
    CHECK (sinal_pago_centavos >= 0),
  CONSTRAINT agendamento_alteracoes_servico_restante_novo_check
    CHECK (restante_novo_centavos IS NULL OR restante_novo_centavos >= 0)
);

CREATE INDEX IF NOT EXISTS idx_agendamento_alteracoes_servico_pendentes
  ON public.agendamento_alteracoes_servico (proxima_tentativa_em, criado_em)
  WHERE estado = 'solicitada';

CREATE INDEX IF NOT EXISTS idx_agendamento_alteracoes_servico_agendamento
  ON public.agendamento_alteracoes_servico (agendamento_id, criado_em DESC);

COMMIT;
