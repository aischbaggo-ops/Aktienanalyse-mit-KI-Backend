-- Ergaenzt request_log um score_stabilitaet, analog zu den bereits
-- vorhandenen Spalten score_total/score_fundamental/score_qualitaet/
-- score_krise/score_trend. stock_analyses.score_stabilitaet existiert
-- bereits im Ursprungsschema und ist hiervon nicht betroffen.
alter table public.request_log
  add column if not exists score_stabilitaet numeric;
