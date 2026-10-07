-- Ticket f): Ein fehlgeschlagener oder unvollstaendiger Refresh ueberschreibt
-- keine gueltige Analyse mehr. Der Zustand des letzten Laufs steht getrennt
-- von den Analysedaten:
--   status            Zustand der gespeicherten Analyse (done/error/running)
--                     - bei vorhandener gueltiger Analyse bleibt er "done"
--   last_run_status   Zustand des letzten Laufs (running/done/error)
-- Bestehende Spalten und Zeilen bleiben unveraendert (kein Backfill); Zeilen
-- ohne last_run_status stammen aus der Zeit vor dieser Migration.

alter table stock_analyses
  add column if not exists last_run_status text
    check (last_run_status in ('running', 'done', 'error')),
  add column if not exists last_run_error_public text,
  add column if not exists last_run_at timestamptz;

-- Interner Fehlertext des letzten Laufs (kann Anbieter-Rohtext enthalten).
-- BEWUSST NICHT als Spalte in stock_analyses: die Tabelle ist fuer alle
-- authentifizierten Nutzer lesbar und wird per Realtime komplett
-- uebertragen. Spalten-Grants wuerden jedes select('*') abbrechen, eine
-- View schuetzt den Realtime-Kanal nicht (gleiche Begruendung wie
-- 20260924120000_hide_stock_analyses_costs.sql). Daher eigene admin-only
-- Tabelle, geschrieben nur von der analyse-Function (Service-Role).
create table if not exists stock_analyses_last_run_error (
  ticker text primary key,
  last_run_error text,
  updated_at timestamptz not null default now()
);

alter table stock_analyses_last_run_error enable row level security;

drop policy if exists stock_analyses_last_run_error_select_admin on stock_analyses_last_run_error;
create policy stock_analyses_last_run_error_select_admin
  on stock_analyses_last_run_error
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Default-Grants auf anon/authenticated nicht mitnehmen: lesen nur
-- authenticated (Admins ueber die Policy), schreiben nur die Service-Role.
revoke all on stock_analyses_last_run_error from anon;
revoke insert, update, delete, truncate, references, trigger
  on stock_analyses_last_run_error from authenticated;

-- updated_at ist das Datum der gespeicherten Analyse (Cache-Alter,
-- "Aktualisiert", Dashboard, PDF). Der bisherige Trigger setzt es bei JEDEM
-- UPDATE neu - schon das Markieren eines Laufs als "running" haette eine
-- alte Analyse damit wieder 7 Tage "frisch" gemacht. Neu: Aendern sich nur
-- die last_run_*-Spalten und ist der Lauf nicht erfolgreich (running/error),
-- bleibt updated_at stehen. Jeder erfolgreiche Lauf (last_run_status =
-- 'done') und jede Aenderung an Analysedaten setzt es wie bisher auf now().
-- set_updated_at() selbst bleibt unveraendert.
create or replace function stock_analyses_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  run_cols text[] := array['last_run_status', 'last_run_error_public', 'last_run_at', 'updated_at'];
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

drop trigger if exists trg_stock_analyses_updated_at on stock_analyses;
create trigger trg_stock_analyses_updated_at
  before update on stock_analyses
  for each row execute function stock_analyses_set_updated_at();
