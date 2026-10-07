-- Batch-Betrieb: maschinenlesbarer Grund des letzten Fehlschlags, damit das
-- Frontend im Batch nur bei einem Rate-Limit wartet und wiederholt.
-- Werte (siehe _shared/fmpStatus.ts RunErrorCode): fmp_not_found, fmp_plan,
-- fmp_rate_limit, fmp_outage, fmp_auth, fmp_network, fmp_other,
-- llm_rate_limit, llm_error, score_incomplete. Kein Fehlertext, daher wie
-- last_run_error_public fuer alle authentifizierten Nutzer lesbar.
-- Nullable, kein Backfill.
--
-- Zeitstempel bewusst VOR der noch offenen View-Migration 20261007120000,
-- aber nach der zuletzt eingespielten 20261007100000.

alter table stock_analyses
  add column if not exists last_run_error_code text;

-- Die neue Spalte gehoert zu den Laufspalten: aendert sich nur sie (mit den
-- uebrigen last_run_*), bleibt updated_at stehen. Sonst wie 20261007100000.
create or replace function stock_analyses_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  run_cols text[] := array['last_run_status', 'last_run_error_public', 'last_run_error_code', 'last_run_at', 'updated_at'];
begin
  if new.last_run_status is distinct from 'done'
     and (to_jsonb(new) - run_cols) = (to_jsonb(old) - run_cols) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;
