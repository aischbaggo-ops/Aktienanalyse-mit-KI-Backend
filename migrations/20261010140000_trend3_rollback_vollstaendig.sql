-- ---------------------------------------------------------------------------
-- Methodik 3: Sicherung und Rollback vervollstaendigen
-- ---------------------------------------------------------------------------
-- Zwei Luecken aus dem Durchlauf-Test vom 10.10.2026 (Migration
-- 20261010120000 bleibt unveraendert, sie ist schon angewendet):
--
--  1. recalc-trend schreibt chart_data->'returnBars' neu (Kalenderjahre statt
--     Stichtagsjahre, Entscheidung vom 10.10.2026), die Sicherung hatte dafuer
--     aber keine Spalte. Der Rollback liess die neuen Balken stehen.
--  2. Fuer Ticker ohne gueltiges Zeitfenster muessen last_run_status,
--     last_run_error_code und last_run_error_public gesetzt werden, sonst
--     zeigt die Tabelle "Fehler" statt "nicht bewertbar": sie liest den Text
--     ueber attachErrorInfo() aus diesen Spalten, nicht aus
--     error_message_public. Also muessen sie auch gesichert werden.
-- ---------------------------------------------------------------------------

-- 1. Sicherungstabelle erweitern ---------------------------------------------
alter table public.trend_backup_20261010
  add column if not exists chart_return_bars     jsonb,
  add column if not exists last_run_status       text,
  add column if not exists last_run_error_code   text,
  add column if not exists last_run_error_public text;

comment on column public.trend_backup_20261010.chart_return_bars is
  'chart_data->''returnBars'' vor der Neuberechnung. Wird von recalc-trend '
  'ueberschrieben und muss daher mitgesichert werden.';

-- 2. apply_trend3 ersetzen ---------------------------------------------------
-- Die Signatur aendert sich, deshalb die alte Fassung ausdruecklich entfernen:
-- "create or replace" mit anderer Parameterliste wuerde eine zweite,
-- ueberladene Funktion anlegen und die alte stehen lassen.
drop function if exists public.apply_trend3(
  text, timestamptz, numeric, numeric, jsonb, jsonb, text, text, text
);

create or replace function public.apply_trend3(
  p_ticker                text,
  p_expected_updated_at   timestamptz,
  p_score_trend           numeric,
  p_score_total           numeric,
  p_criteria              jsonb,
  p_chart_data            jsonb,
  p_status                text,
  p_error_message         text,
  p_error_message_public  text,
  p_last_run_status       text,
  p_last_run_error_code   text,
  p_last_run_error_public text
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
    chart_price_monthly, chart_return_bars, status, error_message,
    error_message_public, last_run_status, last_run_error_code,
    last_run_error_public, updated_at
  ) values (
    v_row.ticker, v_row.score_trend, v_row.score_total, v_row.criteria,
    v_row.chart_data -> 'trend', v_row.chart_data -> 'data_flags',
    v_row.chart_data -> 'priceMonthly', v_row.chart_data -> 'returnBars',
    v_row.status, v_row.error_message, v_row.error_message_public,
    v_row.last_run_status, v_row.last_run_error_code, v_row.last_run_error_public,
    v_row.updated_at
  )
  on conflict (ticker) do nothing;   -- erste Sicherung gewinnt

  perform set_config('app.keep_updated_at', 'on', true);

  update public.stock_analyses set
    score_trend           = p_score_trend,
    score_total           = p_score_total,
    criteria              = p_criteria,
    chart_data            = p_chart_data,
    status                = p_status,
    error_message         = p_error_message,
    error_message_public  = p_error_message_public,
    last_run_status       = p_last_run_status,
    last_run_error_code   = p_last_run_error_code,
    last_run_error_public = p_last_run_error_public
  where ticker = p_ticker;

  return jsonb_build_object(
    'ticker', p_ticker,
    'score_trend_alt', v_row.score_trend,
    'score_total_alt', v_row.score_total,
    'status_alt', v_row.status,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.apply_trend3(
  text, timestamptz, numeric, numeric, jsonb, jsonb, text, text, text, text, text, text
) from public, anon, authenticated;

comment on function public.apply_trend3(
  text, timestamptz, numeric, numeric, jsonb, jsonb, text, text, text, text, text, text
) is
  'Schreibt eine auf Methodik 3 neu gerechnete Trend-Bewertung. Sichert den '
  'Vorzustand vollstaendig nach trend_backup_20261010, haelt updated_at fest '
  'und bricht ab, wenn die Zeile zwischenzeitlich geaendert wurde. Nur Service-Role.';

-- 3. rollback_trend3 ersetzen ------------------------------------------------
-- Zeilenweise Schleife statt eines gebuendelten UPDATE: die chart_data-Teile
-- werden nur dann zurueckgeschrieben, wenn sie gesichert wurden. Ein
-- pauschales jsonb_set mit coalesce(..., 'null') wuerde fehlende Teile auf
-- JSON-null setzen, statt sie zu lassen.
create or replace function public.rollback_trend3(p_tickers text[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.trend_backup_20261010;
  v_chart jsonb;
  v_count integer := 0;
begin
  perform set_config('app.keep_updated_at', 'on', true);

  for b in
    select * from public.trend_backup_20261010
     where p_tickers is null or ticker = any(p_tickers)
     order by ticker
  loop
    select chart_data into v_chart from public.stock_analyses
     where ticker = b.ticker for update;
    if not found then
      continue;
    end if;
    v_chart := coalesce(v_chart, '{}'::jsonb);
    if b.chart_trend is not null then
      v_chart := jsonb_set(v_chart, '{trend}', b.chart_trend, true);
    end if;
    if b.chart_data_flags is not null then
      v_chart := jsonb_set(v_chart, '{data_flags}', b.chart_data_flags, true);
    end if;
    if b.chart_price_monthly is not null then
      v_chart := jsonb_set(v_chart, '{priceMonthly}', b.chart_price_monthly, true);
    end if;
    if b.chart_return_bars is not null then
      v_chart := jsonb_set(v_chart, '{returnBars}', b.chart_return_bars, true);
    end if;

    update public.stock_analyses set
      score_trend           = b.score_trend,
      score_total           = b.score_total,
      criteria              = b.criteria,
      chart_data            = v_chart,
      status                = b.status,
      error_message         = b.error_message,
      error_message_public  = b.error_message_public,
      last_run_status       = b.last_run_status,
      last_run_error_code   = b.last_run_error_code,
      last_run_error_public = b.last_run_error_public
    where ticker = b.ticker;
    v_count := v_count + 1;
  end loop;

  -- updated_at wird nicht gesetzt: der Trigger-Schalter uebernimmt
  -- old.updated_at, und das ist der Wert von vor der Neuberechnung, weil
  -- apply_trend3 ihn nie veraendert hat.
  return v_count;
end;
$$;

revoke all on function public.rollback_trend3(text[]) from public, anon, authenticated;
