-- Assertions da migracao 024 em PostgreSQL 17 TEMPORARIO.
-- Executar apos aplicar 023 e 024 DUAS VEZES.
-- Testes sao transacionais e nao deixam dados artificiais no banco.
BEGIN;

DO $$
DECLARE
  tabelas INTEGER;
  registros INTEGER;
BEGIN
  SELECT COUNT(*) INTO tabelas
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'google_calendar_oauth_states',
      'google_calendar_oauth_credentials',
      'google_calendar_event_links',
      'google_calendar_sync_operations',
      'google_calendar_reconciliation_candidates'
    );
  IF tabelas <> 5 THEN
    RAISE EXCEPTION 'Faltam tabelas (023/024): %', tabelas;
  END IF;
  SELECT
    (SELECT COUNT(*) FROM public.google_calendar_event_links) +
    (SELECT COUNT(*) FROM public.google_calendar_sync_operations) +
    (SELECT COUNT(*) FROM public.google_calendar_reconciliation_candidates)
  INTO registros;
  IF registros <> 0 THEN
    RAISE EXCEPTION 'Migracao 024 nao deve popular nenhum registro: %', registros;
  END IF;
END $$;

-- VINCULO CONFIRMADO: um agendamento, um events.id Google por calendario.
INSERT INTO public.google_calendar_event_links (
  agendamento_id, calendar_id, google_event_id, origem,
  metodo_verificacao, verificado_em, verificado_por
) VALUES (
  'agendamento-001', 'agenda@example.com', 'google-event-001',
  'vps', 'google_api', NOW(), 'verificacao-api'
);

DO $$
BEGIN
  -- Dois agendamentos nao podem apontar ao mesmo evento do Google.
  BEGIN
    INSERT INTO public.google_calendar_event_links (
      agendamento_id, calendar_id, google_event_id, origem,
      metodo_verificacao, verificado_em, verificado_por
    ) VALUES (
      'agendamento-002', 'agenda@example.com', 'google-event-001',
      'vps', 'google_api', NOW(), 'verificacao-api'
    );
    RAISE EXCEPTION 'PERIGO: duplicacao de google_event_id aceita';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Um mesmo agendamento nao pode mapear para outro evento.
  BEGIN
    INSERT INTO public.google_calendar_event_links (
      agendamento_id, calendar_id, google_event_id, origem,
      metodo_verificacao, verificado_em, verificado_por
    ) VALUES (
      'agendamento-001', 'agenda@example.com', 'google-event-002',
      'vps', 'google_api', NOW(), 'verificacao-api'
    );
    RAISE EXCEPTION 'PERIGO: duplicacao de agendamento aceita';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- IDs iCalUID antigos frequentemente terminam com @google.com.
  -- Nao devem passar como events.id Google confirmado.
  BEGIN
    INSERT INTO public.google_calendar_event_links (
      agendamento_id, calendar_id, google_event_id, origem,
      metodo_verificacao, verificado_em, verificado_por
    ) VALUES (
      'agendamento-002', 'agenda@example.com', 'legacy@google.com',
      'legado_validado', 'revisao_manual_confirmada', NOW(), 'admin'
    );
    RAISE EXCEPTION 'PERIGO: iCalUID aceito como events.id validado';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Evento novo da VPS nao pode ser marcado apenas por revisao manual.
  BEGIN
    INSERT INTO public.google_calendar_event_links (
      agendamento_id, calendar_id, google_event_id, origem,
      metodo_verificacao, verificado_em, verificado_por
    ) VALUES (
      'agendamento-002', 'agenda@example.com', 'google-event-002',
      'vps', 'revisao_manual_confirmada', NOW(), 'admin'
    );
    RAISE EXCEPTION 'PERIGO: evento VPS sem verificacao da API aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- OPERACOES: uma unica intencao ativa por agendamento e chave idempotente.
INSERT INTO public.google_calendar_sync_operations (
  operation_id, chave_idempotencia, agendamento_id, calendar_id,
  tipo, fingerprint_pedido
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'calendar-intent-00000001', 'agendamento-001', 'agenda@example.com',
  'criar', repeat('a', 64)
);

DO $$
BEGIN
  -- Nao pode existir outra operacao pendente/indefinida para a mesma reserva.
  BEGIN
    INSERT INTO public.google_calendar_sync_operations (
      operation_id, chave_idempotencia, agendamento_id, calendar_id,
      tipo, google_event_id, fingerprint_pedido
    ) VALUES (
      '00000000-0000-4000-8000-000000000002',
      'calendar-intent-00000002', 'agendamento-001', 'agenda@example.com',
      'reagendar', 'google-event-001', repeat('b', 64)
    );
    RAISE EXCEPTION 'PERIGO: duas operacoes ativas para mesmo agendamento';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- PATCH/CANCELAMENTO nunca devem entrar na outbox sem events.id Google.
  BEGIN
    INSERT INTO public.google_calendar_sync_operations (
      operation_id, chave_idempotencia, agendamento_id, calendar_id,
      tipo, fingerprint_pedido
    ) VALUES (
      '00000000-0000-4000-8000-000000000003',
      'calendar-intent-00000003', 'agendamento-002', 'agenda@example.com',
      'cancelar', repeat('b', 64)
    );
    RAISE EXCEPTION 'PERIGO: cancelamento sem event id aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.google_calendar_sync_operations (
      operation_id, chave_idempotencia, agendamento_id, calendar_id,
      tipo, fingerprint_pedido, estado
    ) VALUES (
      '00000000-0000-4000-8000-000000000004',
      'calendar-intent-00000004', 'agendamento-002', 'agenda@example.com',
      'criar', repeat('b', 64), 'concluida'
    );
    RAISE EXCEPTION 'PERIGO: concluida sem timestamp aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

UPDATE public.google_calendar_sync_operations
SET estado = 'aguardando_confirmacao'
WHERE operation_id = '00000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  -- Timeout de escrita nao libera criacao duplicada.
  BEGIN
    INSERT INTO public.google_calendar_sync_operations (
      operation_id, chave_idempotencia, agendamento_id, calendar_id,
      tipo, google_event_id, fingerprint_pedido
    ) VALUES (
      '00000000-0000-4000-8000-000000000002',
      'calendar-intent-00000002', 'agendamento-001', 'agenda@example.com',
      'reagendar', 'google-event-001', repeat('b', 64)
    );
    RAISE EXCEPTION 'PERIGO: operacao indefinida liberou nova escrita';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Somente estado terminal com confirmacao libera nova intencao.
UPDATE public.google_calendar_sync_operations
SET estado = 'concluida', concluido_em = NOW()
WHERE operation_id = '00000000-0000-4000-8000-000000000001';

INSERT INTO public.google_calendar_sync_operations (
  operation_id, chave_idempotencia, agendamento_id, calendar_id,
  tipo, google_event_id, fingerprint_pedido
) VALUES (
  '00000000-0000-4000-8000-000000000002',
  'calendar-intent-00000002', 'agendamento-001', 'agenda@example.com',
  'reagendar', 'google-event-001', repeat('b', 64)
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.google_calendar_sync_operations (
      operation_id, chave_idempotencia, agendamento_id, calendar_id,
      tipo, google_event_id, fingerprint_pedido
    ) VALUES (
      '00000000-0000-4000-8000-000000000005',
      'calendar-intent-00000002', 'agendamento-003', 'agenda@example.com',
      'reagendar', 'google-event-003', repeat('c', 64)
    );
    RAISE EXCEPTION 'PERIGO: mesma chave idempotencia aceita duas vezes';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- CONCILIACAO: varias hipoteses para a mesma reserva devem ser mantidas.
-- Um ID historico como @google.com e armazenado apenas como evidencia.
INSERT INTO public.google_calendar_reconciliation_candidates (
  agendamento_id, calendar_id, google_event_id, legacy_event_id, fonte
) VALUES
  ('agendamento-legacy', 'agenda@example.com', 'google-event-legacy-1',
   'icaluid@google.com', 'pix_outbox'),
  ('agendamento-legacy', 'agenda@example.com', 'google-event-legacy-2',
   'icaluid@google.com', 'google_calendar');

DO $$
DECLARE
  candidatos INTEGER;
BEGIN
  SELECT COUNT(*) INTO candidatos
  FROM public.google_calendar_reconciliation_candidates
  WHERE agendamento_id = 'agendamento-legacy';
  IF candidatos <> 2 THEN
    RAISE EXCEPTION 'Conciliacao apagou ambiguidade: %', candidatos;
  END IF;

  -- Nao pode validar automaticamente uma candidata sem revisao.
  BEGIN
    UPDATE public.google_calendar_reconciliation_candidates
    SET situacao = 'validado'
    WHERE google_event_id = 'google-event-legacy-1';
    RAISE EXCEPTION 'PERIGO: candidata validada sem revisor';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.google_calendar_reconciliation_candidates (
      agendamento_id, calendar_id, google_event_id, fonte
    ) VALUES (
      'agendamento-legacy', 'agenda@example.com',
      'google-event-legacy-1', 'google_calendar'
    );
    RAISE EXCEPTION 'PERIGO: candidata duplicada';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

UPDATE public.google_calendar_reconciliation_candidates
SET situacao = 'validado', revisor_uid = 'admin-isabele', revisado_em = NOW()
WHERE google_event_id = 'google-event-legacy-1';

DO $$
DECLARE
  links INTEGER;
BEGIN
  SELECT COUNT(*) INTO links FROM public.google_calendar_event_links;
  IF links <> 1 THEN
    RAISE EXCEPTION 'Candidatos nao devem automaticamente gerar vinculos: %', links;
  END IF;
END $$;

ROLLBACK;
