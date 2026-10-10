-- ---------------------------------------------------------------------------
-- Methodik 3 (Trend): Sicherungstabelle, Trigger-Schalter und Schreib-RPC
-- ---------------------------------------------------------------------------
-- Entscheidungen Michael vom 10.10.2026:
--  * Neuberechnung nur des Trends, ohne Claude (Variante A2).
--  * updated_at bzw. "Analyse vom" darf sich NICHT verschieben; der
--    Neuberechnungszeitpunkt steht in chart_data.data_flags.trend_recalc_at.
--  * Rollback muss moeglich sein.
-- Diese Migration aendert KEINE Analysedaten. Sie legt nur die Mittel an.
-- ---------------------------------------------------------------------------

-- 1. Sicherungstabelle -------------------------------------------------------
-- Haelt je Ticker den Zustand VOR der ersten Neuberechnung. Primary Key auf
-- ticker: ein zweiter Lauf ueberschreibt die Sicherung nicht, der Rueckweg
-- fuehrt also immer auf Methodik 2 zurueck, nicht auf einen Zwischenstand.
create table if not exists public.trend_backup_20261010 (
  ticker            text primary key,
  score_trend       numeric,
  score_total       numeric,
  criteria          jsonb,        -- VOLLSTAENDIGE criteria-Liste, nicht nur Trend
  chart_trend       jsonb,        -- chart_data->'trend'
  chart_data_flags  jsonb,        -- chart_data->'data_flags'
  chart_price_monthly jsonb,      -- chart_data->'priceMonthly'
  status            text,
  error_message        text,
  error_message_public text,
  updated_at        timestamptz,  -- der zu erhaltende Originalwert
  saved_at          timestamptz not null default now()
);

comment on table public.trend_backup_20261010 is
  'Zustand vor der Trend-Neuberechnung auf Methodik 3 (10.10.2026). Nur Service-Role.';

-- Reine Servicetabelle: RLS an, keine Policy. Damit kommt ueber die API
-- (anon/authenticated) niemand heran, der Service-Role-Client umgeht RLS.
alter table public.trend_backup_20261010 enable row level security;
revoke all on public.trend_backup_20261010 from anon, authenticated;

-- 2. Trigger-Schalter --------------------------------------------------------
-- Der bestehende Trigger setzt updated_at bei jeder Aenderung an
-- Analysedaten auf now(). Fuer die Neuberechnung brauchen wir genau dafuer
-- eine Ausnahme. Der Schalter ist eine transaktionslokale Einstellung
-- (set_config(..., true)) und standardmaessig aus: ohne ihn verhaelt sich der
-- Trigger exakt wie bisher.
create or replace function public.stock_analyses_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  run_cols text[] := array['last_run_status', 'last_run_error_public', 'last_run_at', 'updated_at'];
begin
  if coalesce(current_setting('app.keep_updated_at', true), 'off') = 'on' then
    -- Nur fuer die Trend-Neuberechnung (siehe apply_trend3): die Analyse ist
    -- inhaltlich dieselbe, nur anders gerechnet - "Analyse vom" bleibt stehen.
    new.updated_at := old.updated_at;
  elsif new.last_run_status is distinct from 'done'
     and (to_jsonb(new) - run_cols) = (to_jsonb(old) - run_cols) then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- 3. Schreib-RPC -------------------------------------------------------------
-- Sichern und Schreiben in EINER Transaktion, mit optimistischer Sperre auf
-- updated_at. Laeuft parallel ein Analyse-Lauf und schreibt dieselbe Zeile,
-- schlaegt der Aufruf fehl statt dessen Ergebnis zu ueberschreiben.
create or replace function public.apply_trend3(
  p_ticker               text,
  p_expected_updated_at  timestamptz,
  p_score_trend          numeric,
  p_score_total          numeric,
  p_criteria             jsonb,
  p_chart_data           jsonb,
  p_status               text,
  p_error_message        text,
  p_error_message_public text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stock_analyses;
begin
  select * into v_row from public.stock_analyses where ticker = p_ticker for update;
  if not found then
    raise exception 'Ticker % nicht gefunden', p_ticker using errcode = 'no_data_found';
  end if;
  if v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'Zeile % wurde zwischenzeitlich geaendert (updated_at % statt %)',
      p_ticker, v_row.updated_at, p_expected_updated_at using errcode = 'serialization_failure';
  end if;

  insert into public.trend_backup_20261010 (
    ticker, score_trend, score_total, criteria, chart_trend, chart_data_flags,
    chart_price_monthly, status, error_message, error_message_public, updated_at
  ) values (
    v_row.ticker, v_row.score_trend, v_row.score_total, v_row.criteria,
    v_row.chart_data -> 'trend', v_row.chart_data -> 'data_flags',
    v_row.chart_data -> 'priceMonthly', v_row.status, v_row.error_message,
    v_row.error_message_public, v_row.updated_at
  )
  on conflict (ticker) do nothing;   -- erste Sicherung gewinnt

  perform set_config('app.keep_updated_at', 'on', true);

  update public.stock_analyses set
    score_trend          = p_score_trend,
    score_total          = p_score_total,
    criteria             = p_criteria,
    chart_data           = p_chart_data,
    status               = p_status,
    error_message        = p_error_message,
    error_message_public = p_error_message_public
  where ticker = p_ticker;

  return jsonb_build_object(
    'ticker', p_ticker,
    'score_trend_alt', v_row.score_trend,
    'score_total_alt', v_row.score_total,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.apply_trend3(
  text, timestamptz, numeric, numeric, jsonb, jsonb, text, text, text
) from public, anon, authenticated;

comment on function public.apply_trend3(
  text, timestamptz, numeric, numeric, jsonb, jsonb, text, text, text
) is
  'Schreibt eine auf Methodik 3 neu gerechnete Trend-Bewertung. Sichert den '
  'Vorzustand nach trend_backup_20261010, haelt updated_at fest und bricht ab, '
  'wenn die Zeile zwischenzeitlich geaendert wurde. Nur Service-Role.';

-- 4. Rueckweg ----------------------------------------------------------------
-- Stellt den gesicherten Zustand wieder her, inklusive updated_at. Der
-- Rueckweg ist bewusst eine eigene Funktion und kein Handbetrieb, damit er
-- unter Druck nicht improvisiert werden muss.
create or replace function public.rollback_trend3(p_tickers text[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform set_config('app.keep_updated_at', 'on', true);
  with src as (
    select * from public.trend_backup_20261010 b
     where p_tickers is null or b.ticker = any(p_tickers)
  )
  update public.stock_analyses a set
    score_trend          = s.score_trend,
    score_total          = s.score_total,
    criteria             = s.criteria,
    chart_data           = jsonb_set(
                             jsonb_set(
                               jsonb_set(a.chart_data,
                                 '{trend}', coalesce(s.chart_trend, 'null'::jsonb), true),
                               '{data_flags}', coalesce(s.chart_data_flags, 'null'::jsonb), true),
                             '{priceMonthly}', coalesce(s.chart_price_monthly, 'null'::jsonb), true),
    status               = s.status,
    error_message        = s.error_message,
    error_message_public = s.error_message_public
  from src s
  where a.ticker = s.ticker;
  get diagnostics v_count = row_count;
  -- updated_at haengt am Trigger-Schalter oben, deshalb hier nicht gesetzt:
  -- der Trigger uebernimmt old.updated_at, und das ist der Wert, der schon vor
  -- der Neuberechnung in der Zeile stand (apply_trend3 hat ihn nie veraendert).
  return v_count;
end;
$$;

revoke all on function public.rollback_trend3(text[]) from public, anon, authenticated;
