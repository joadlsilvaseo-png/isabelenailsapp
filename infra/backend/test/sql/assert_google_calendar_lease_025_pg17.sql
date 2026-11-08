-- Somente PostgreSQL 17 de CI. Testes transacionais / rollback.
BEGIN;

DO $$
DECLARE
  existe INTEGER;
BEGIN
  SELECT COUNT(*) INTO existe
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name='google_calendar_sync_operations'
    AND column_name='lease_token';
  IF existe <> 1 THEN RAISE EXCEPTION 'Coluna lease_token ausente'; END IF;
END $$;

INSERT INTO public.google_calendar_sync_operations (
  operation_id, chave_idempotencia, agendamento_id, calendar_id,
  tipo, google_event_id, fingerprint_pedido
) VALUES (
  '00000000-0000-4000-8000-000000000100',
  'cutover-operation-001', 'agendamento-cutover-01',
  'agenda@example.com', 'criar', 'imn12345678', repeat('a',64)
);

DO $$
BEGIN
  -- Estado "processando" exige token e prazo.
  BEGIN
    UPDATE public.google_calendar_sync_operations
    SET estado = 'processando', bloqueado_ate = NOW() + INTERVAL '2 minutes'
    WHERE operation_id = '00000000-0000-4000-8000-000000000100';
    RAISE EXCEPTION 'PERIGO: processando sem token aceito';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

UPDATE public.google_calendar_sync_operations
SET estado = 'processando',
    lease_token = '00000000-0000-4000-8000-000000000101',
    bloqueado_ate = NOW() + INTERVAL '2 minutes'
WHERE operation_id = '00000000-0000-4000-8000-000000000100';

DO $$
BEGIN
  -- Ao sair de processando o token de posse deve ser limpo.
  BEGIN
    UPDATE public.google_calendar_sync_operations
    SET estado = 'aguardando_confirmacao',
        bloqueado_ate = NULL
    WHERE operation_id = '00000000-0000-4000-8000-000000000100';
    RAISE EXCEPTION 'PERIGO: token persistido depois do estado incerto';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

UPDATE public.google_calendar_sync_operations
SET estado = 'aguardando_confirmacao',
    lease_token = NULL, bloqueado_ate = NULL
WHERE operation_id = '00000000-0000-4000-8000-000000000100';

DO $$
DECLARE
  status_atual TEXT;
BEGIN
  SELECT estado INTO status_atual
  FROM public.google_calendar_sync_operations
  WHERE operation_id = '00000000-0000-4000-8000-000000000100';
  IF status_atual <> 'aguardando_confirmacao' THEN
    RAISE EXCEPTION 'Status incerto nao preservado';
  END IF;
  -- Nao pode surgir outra operacao durante resultado indefinido.
  BEGIN
    INSERT INTO public.google_calendar_sync_operations (
      operation_id, chave_idempotencia, agendamento_id, calendar_id,
      tipo, google_event_id, fingerprint_pedido
    ) VALUES (
      '00000000-0000-4000-8000-000000000102',
      'cutover-operation-002', 'agendamento-cutover-01',
      'agenda@example.com', 'criar', 'imn12345678', repeat('b',64)
    );
    RAISE EXCEPTION 'PERIGO: outra operacao liberada com resposta incerta';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
