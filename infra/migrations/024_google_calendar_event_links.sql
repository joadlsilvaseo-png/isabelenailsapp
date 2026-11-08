BEGIN;

-- FASE 2.3 — Estruturas ADITIVAS para conciliacao segura com Google Calendar.
-- Nao altera o estado de nenhum agendamento nem consulta/grava a API Google.
-- Sem populacao automatica: IDs legados do Apps Script podem ser iCalUID,
-- diferentes do verdadeiro events.id utilizado pela API Google.

-- Apenas vinculos CONFIRMADOS: nunca inserir por coincidencia de nome/data.
-- Um agendamento tem um unico evento confirmado; um events.id por calendario
-- so pode pertencer a um agendamento.
CREATE TABLE IF NOT EXISTS public.google_calendar_event_links (
    agendamento_id TEXT PRIMARY KEY
        CHECK (agendamento_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    calendar_id TEXT NOT NULL
        CHECK (char_length(calendar_id) BETWEEN 1 AND 300 AND calendar_id !~ '[[:space:]]'),
    google_event_id TEXT NOT NULL
        CHECK ((google_event_id ~ '^[A-Za-z0-9_-]+$' AND char_length(google_event_id) BETWEEN 5 AND 1024)),
    origem TEXT NOT NULL
        CHECK (origem IN ('vps', 'legado_validado')),
    metodo_verificacao TEXT NOT NULL
        CHECK (metodo_verificacao IN ('google_api', 'revisao_manual_confirmada')),
    situacao TEXT NOT NULL DEFAULT 'ativo'
        CHECK (situacao IN ('ativo', 'cancelado')),
    verificado_em TIMESTAMPTZ NOT NULL,
    verificado_por TEXT NOT NULL
        CHECK (char_length(verificado_por) BETWEEN 1 AND 160),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (calendar_id, google_event_id),
    -- Marcador privado e propriedade gerenciada so existem nos novos
    -- eventos da VPS. Historicos precisam de conciliacao explicita.
    CONSTRAINT google_calendar_links_origem_metodo_check CHECK (
        origem = 'legado_validado' OR metodo_verificacao = 'google_api'
    )
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_links_calendar
    ON public.google_calendar_event_links (calendar_id, situacao);

-- Registro duravel de INTENCOES de sincronizacao futura.
-- Nao existe worker nem rota que preencha ou consuma esta tabela na Fase 2.3.
-- Cada operacao deve possuir chave de idempotencia propria; a revisao
-- (fingerprint SHA-256) representa o pedido imutavel e evita reuso de chave.
CREATE TABLE IF NOT EXISTS public.google_calendar_sync_operations (
    operation_id UUID PRIMARY KEY,
    chave_idempotencia TEXT NOT NULL UNIQUE
        CHECK (char_length(chave_idempotencia) BETWEEN 16 AND 160),
    agendamento_id TEXT NOT NULL
        CHECK (agendamento_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    calendar_id TEXT NOT NULL
        CHECK (char_length(calendar_id) BETWEEN 1 AND 300 AND calendar_id !~ '[[:space:]]'),
    tipo TEXT NOT NULL
        CHECK (tipo IN ('criar', 'reagendar', 'cancelar', 'alterar_servico')),
    google_event_id TEXT
        CHECK (google_event_id IS NULL OR (google_event_id ~ '^[A-Za-z0-9_-]+$' AND char_length(google_event_id) BETWEEN 5 AND 1024)),
    fingerprint_pedido CHAR(64) NOT NULL
        CHECK (fingerprint_pedido ~ '^[a-f0-9]{64}$'),
    estado TEXT NOT NULL DEFAULT 'pendente'
        CHECK (estado IN (
            'pendente', 'processando', 'aguardando_confirmacao',
            'conflito', 'concluida', 'falha_permanente', 'dispensada'
        )),
    tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
    proxima_tentativa_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bloqueado_ate TIMESTAMPTZ,
    ultimo_codigo_erro TEXT
        CHECK (ultimo_codigo_erro IS NULL OR ultimo_codigo_erro ~ '^[A-Z0-9_]{1,64}$'),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    concluido_em TIMESTAMPTZ,
    CONSTRAINT google_calendar_operacoes_tipo_evento_check
        CHECK (tipo = 'criar' OR google_event_id IS NOT NULL),
    CONSTRAINT google_calendar_operacoes_conclusao_check
        CHECK ((estado = 'concluida') = (concluido_em IS NOT NULL))
);

-- No maximo UMA intencao ativa/indefinida por agendamento.
-- 'aguardando_confirmacao' ou 'conflito' bloqueia novas operacoes ate
-- reconciliacao; a fila jamais deve presumir que timeout = falha definitiva.
CREATE UNIQUE INDEX IF NOT EXISTS ux_google_calendar_operacao_ativa
    ON public.google_calendar_sync_operations (agendamento_id)
    WHERE estado IN (
        'pendente', 'processando', 'aguardando_confirmacao', 'conflito'
    );

CREATE INDEX IF NOT EXISTS idx_google_calendar_operacoes_pendentes
    ON public.google_calendar_sync_operations (proxima_tentativa_em, criado_em)
    WHERE estado = 'pendente';

CREATE INDEX IF NOT EXISTS idx_google_calendar_operacoes_lease
    ON public.google_calendar_sync_operations (bloqueado_ate)
    WHERE estado = 'processando';

CREATE INDEX IF NOT EXISTS idx_google_calendar_operacoes_historico
    ON public.google_calendar_sync_operations (agendamento_id, criado_em DESC);

-- Hipoteses de correspondencia dos legados. Nao criam vinculos confirmados.
-- Pode haver MAIS DE UMA candidata por agendamento: ambiguidades precisam
-- continuar visiveis e impedir a migracao automatica.
CREATE TABLE IF NOT EXISTS public.google_calendar_reconciliation_candidates (
    id BIGSERIAL PRIMARY KEY,
    agendamento_id TEXT NOT NULL
        CHECK (agendamento_id ~ '^[A-Za-z0-9_-]{1,128}$'),
    calendar_id TEXT NOT NULL
        CHECK (char_length(calendar_id) BETWEEN 1 AND 300 AND calendar_id !~ '[[:space:]]'),
    google_event_id TEXT NOT NULL
        CHECK ((google_event_id ~ '^[A-Za-z0-9_-]+$' AND char_length(google_event_id) BETWEEN 5 AND 1024)),
    legacy_event_id TEXT
        CHECK (legacy_event_id IS NULL OR char_length(legacy_event_id) BETWEEN 1 AND 1024),
    fonte TEXT NOT NULL
        CHECK (fonte IN ('pix_outbox', 'firestore', 'google_calendar', 'revisao_manual')),
    fingerprint_evidencia CHAR(64)
        CHECK (fingerprint_evidencia IS NULL OR fingerprint_evidencia ~ '^[a-f0-9]{64}$'),
    situacao TEXT NOT NULL DEFAULT 'pendente'
        CHECK (situacao IN (
            'pendente', 'revisao_manual', 'validado', 'rejeitado', 'conflito'
        )),
    revisor_uid TEXT,
    revisado_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agendamento_id, calendar_id, google_event_id),
    CONSTRAINT google_calendar_candidato_revisao_check CHECK (
        (revisor_uid IS NULL AND revisado_em IS NULL)
        OR (revisor_uid IS NOT NULL AND revisado_em IS NOT NULL)
    ),
    CONSTRAINT google_calendar_candidato_estado_revisao_check CHECK (
        situacao NOT IN ('validado', 'rejeitado')
        OR (revisor_uid IS NOT NULL AND revisado_em IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_google_calendar_candidatos_pendentes
    ON public.google_calendar_reconciliation_candidates (situacao, criado_em)
    WHERE situacao IN ('pendente', 'revisao_manual', 'conflito');

CREATE INDEX IF NOT EXISTS idx_google_calendar_candidatos_evento
    ON public.google_calendar_reconciliation_candidates (calendar_id, google_event_id);

CREATE INDEX IF NOT EXISTS idx_google_calendar_candidatos_agendamento
    ON public.google_calendar_reconciliation_candidates (agendamento_id, situacao);

COMMIT;
