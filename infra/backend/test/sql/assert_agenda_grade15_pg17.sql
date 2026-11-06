-- Após aplicar a migração 022, nenhum dos 185 bloqueios se perdeu.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.agenda_bloqueios) <> 185 THEN
    RAISE EXCEPTION 'A migração alterou a quantidade de bloqueios antigos';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agenda_bloqueios
             WHERE fim_minuto - inicio_minuto <> 30 OR inicio_minuto % 30 <> 0) THEN
    RAISE EXCEPTION 'A migração alterou o período dos bloqueios antigos';
  END IF;
END $$;

-- 15 min válidos adjacentes ao legado não são sobreposição.
INSERT INTO public.agenda_bloqueios
  (data_servico, inicio_minuto, fim_minuto, alterado_por_uid)
VALUES ('2026-11-03', 1215, 1230, 'admin-teste');

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.agenda_bloqueios) <> 186 THEN
    RAISE EXCEPTION 'Não foi possível adicionar um novo bloqueio de 15 min';
  END IF;
  BEGIN
    -- 19h45–20h sobrepõe o legado 19h30–20h; restrição deve recusar.
    INSERT INTO public.agenda_bloqueios
      (data_servico, inicio_minuto, fim_minuto, alterado_por_uid)
    VALUES ('2026-11-03', 1185, 1200, 'admin-teste');
    RAISE EXCEPTION 'ERRO: banco aceitou sobreposição de bloqueios';
  EXCEPTION
    WHEN exclusion_violation THEN NULL;
  END;
  IF (SELECT COUNT(*) FROM public.agenda_bloqueios) <> 186 THEN
    RAISE EXCEPTION 'Validação de sobreposição modificou bloqueios';
  END IF;
END $$;
