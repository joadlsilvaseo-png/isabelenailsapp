-- Executado SOMENTE no PostgreSQL 17 temporário do CI.
\set ON_ERROR_STOP on

INSERT INTO public.agenda_bloqueios
  (data_servico, inicio_minuto, fim_minuto, alterado_por_uid)
SELECT DATE '2026-11-03' + (g / 40), (g % 40) * 30, (g % 40) * 30 + 30, 'admin-teste'
FROM generate_series(0, 184) g;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.agenda_bloqueios) <> 185 THEN
    RAISE EXCEPTION 'Fixtures: esperado 185 bloqueios legados';
  END IF;
END $$;
