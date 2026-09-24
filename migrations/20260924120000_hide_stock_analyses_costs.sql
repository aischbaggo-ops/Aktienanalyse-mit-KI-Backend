-- Pentest-Fix: tokens_input/tokens_output/cost_usd_claude aus dem fuer
-- ALLE authentifizierten Nutzer geteilten stock_analyses-Read entfernen
-- (siehe stock_analyses_select_authenticated: "for select to
-- authenticated using (true)", bewusst geteilter Ticker-Cache - siehe
-- fix/pentest-findings-Branch, 20260924090000_document_legacy_rls_policies.sql).
--
-- WARUM WEDER VIEW NOCH SPALTEN-GRANTS ALLEIN AUSREICHEN:
-- Ein Spalten-GRANT/REVOKE wuerde jede bestehende "select('*')"-Abfrage
-- im Frontend mit "permission denied" hart abbrechen lassen (Postgres
-- verweigert die GESAMTE Abfrage, sobald nur eine angefragte Spalte
-- fehlt) und muesste bei jeder kuenftigen neuen Spalte manuell
-- nachgezogen werden. Eine reine View (stock_analyses_public ohne die
-- drei Spalten + REVOKE auf die Basistabelle) wuerde zwar die
-- REST-Reads absichern, aber NICHT den Realtime-Kanal: AnalysePage.tsx
-- abonniert postgres_changes DIREKT auf der Basistabelle (Views sind
-- nicht realtime-faehig, Postgres repliziert keine Views), und Realtime
-- sendet bei einem Treffer die vollstaendige Zeile inkl. aller Spalten
-- ueber den WebSocket - eine restriktivere RLS-Policy wuerde ausserdem
-- die Realtime-Updates fuer alle Nicht-Admins komplett stillzulegen,
-- eine offene RLS-Policy (fuer Realtime noetig) wuerde die Kosten-
-- Spalten aber weiterhin ueber den WebSocket-Payload durchreichen.
--
-- Sauberer Fix daher: die drei Spalten komplett aus stock_analyses
-- entfernen und in eine eigene, admin-only Tabelle auslegern. Die
-- Batch-Kostenschaetzung (useBatchAnalysis.ts, fuer normale Nutzer VOR
-- dem Start eines Batches) braucht weiterhin einen groben Mittelwert -
-- dafuer eine SECURITY DEFINER RPC, die NUR den Durchschnitt liefert,
-- nie einzelne Zeilen/Kosten.

create table if not exists stock_analyses_costs (
  -- Kein "references stock_analyses(ticker)" - die genaue Constraint-
  -- Lage auf stock_analyses.ticker ist nicht per Migration bekannt
  -- (Tabelle vor dieser Migrationshistorie erstellt, siehe Kommentar in
  -- 20260924090000_document_legacy_rls_policies.sql), daher keine FK
  -- ohne Bestaetigung riskieren.
  ticker text primary key,
  tokens_input integer,
  tokens_output integer,
  cost_usd_claude numeric,
  updated_at timestamptz not null default now()
);

alter table stock_analyses_costs enable row level security;

-- Gleiches is_admin-Muster wie request_log/function_errors/search_log.
drop policy if exists stock_analyses_costs_select_admin on stock_analyses_costs;
create policy stock_analyses_costs_select_admin
  on stock_analyses_costs
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Liefert NUR den Mittelwert der letzten 20 Analysen (fuer die Batch-
-- Kostenschaetzung, siehe useBatchAnalysis.ts) - SECURITY DEFINER, damit
-- die Funktion trotz der admin-only RLS-Policy oben lesen kann, aber
-- gibt bewusst nie einzelne Zeilen zurueck, nur die aggregierte Zahl.
create or replace function get_avg_recent_analysis_cost()
returns numeric
language sql
security definer
set search_path = public
as $$
  select avg(cost_usd_claude) from (
    select cost_usd_claude
    from stock_analyses_costs
    where cost_usd_claude is not null
    order by updated_at desc
    limit 20
  ) recent;
$$;

grant execute on function get_avg_recent_analysis_cost() to authenticated;

-- Bestehende Werte uebernehmen, bevor die Spalten unten entfernt werden -
-- sonst wuerde die "Kosten (Claude)"-Summe im Admin-Dashboard beim
-- naechsten Laden schlagartig auf den Stand "nur neue Analysen ab jetzt"
-- zurueckfallen.
insert into stock_analyses_costs (ticker, tokens_input, tokens_output, cost_usd_claude, updated_at)
select ticker, tokens_input, tokens_output, cost_usd_claude, updated_at
from stock_analyses
where tokens_input is not null or tokens_output is not null or cost_usd_claude is not null
on conflict (ticker) do nothing;

alter table stock_analyses drop column if exists tokens_input;
alter table stock_analyses drop column if exists tokens_output;
alter table stock_analyses drop column if exists cost_usd_claude;
