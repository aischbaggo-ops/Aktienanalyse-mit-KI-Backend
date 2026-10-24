-- ---------------------------------------------------------------------------
-- Fundamental nachrechnen (Dividendenfeld), Sicherung und Rueckweg
-- ---------------------------------------------------------------------------
-- Der Code las das Dividendenfeld unter dem Namen der alten FMP-API
-- ("dividendsPaid"); die stable-API nennt es commonDividendsPaid. Bei allen
-- 594 Analysen bis zum 24.10.2026 galt deshalb kein Wert als
-- Dividendenzahler, die drei Dividendenkriterien liefen nie.
--
-- recalc-fundamental rechnet den Fundamentalscore ohne Claude neu und
-- schreibt ueber apply_fundamental. Muster wie apply_trend3 (Migrationen
-- 20261010120000 und 20261010140000):
--   * Vorzustand wird VOR dem Schreiben gesichert, erste Sicherung gewinnt
--   * updated_at ("Analyse vom") bleibt stehen - der Trigger-Schalter
--     app.keep_updated_at aus 20261010120000 wird wiederverwendet
--   * Abbruch, wenn die Zeile seit dem Lesen von einem Analyse-Lauf
--     geaendert wurde (optimistische Sperre auf updated_at)
--   * rollback_fundamental stellt den gesicherten Zustand wieder her
--
-- Geaendert werden nur score_fundamental, score_total, criteria (darin nur die
-- Fundamental-Eintraege) und chart_data (fundamentalSeries, data_flags).
-- Status, Fehlertexte, Qualitaet, Krise und Trend bleiben unberuehrt.
-- ---------------------------------------------------------------------------

create table if not exists public.fundamental_backup_20261025 (
  ticker                   text primary key,
  score_fundamental        numeric,
  score_total              numeric,
  criteria                 jsonb,   -- VOLLSTAENDIGE criteria-Liste
  chart_fundamental_series jsonb,   -- chart_data->'fundamentalSeries'
  chart_data_flags         jsonb,   -- chart_data->'data_flags'
  updated_at               timestamptz,  -- der zu erhaltende Originalwert
  saved_at                 timestamptz not null default now()
);

comment on table public.fundamental_backup_20261025 is
  'Zustand vor dem Nachrechnen des Fundamentalscores (Dividendenfeld, 25.10.2026). Nur Service-Role.';

alter table public.fundamental_backup_20261025 enable row level security;
revoke all on public.fundamental_backup_20261025 from anon, authenticated;

create or replace function public.apply_fundamental(
  p_ticker              text,
  p_expected_updated_at timestamptz,
  p_score_fundamental   numeric,
  p_score_total         numeric,
  p_criteria            jsonb,
  p_chart_data          jsonb
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
  -- Nur fertige Analysen: eine Zeile im Fehler- oder Laufzustand hat keinen
  -- Gesamtscore, den man neu bilden koennte.
  if v_row.status is distinct from 'done' then
    raise exception 'Zeile % hat status %, nicht done', p_ticker, v_row.status
      using errcode = 'check_violation';
  end if;

  insert into public.fundamental_backup_20261025 (
    ticker, score_fundamental, score_total, criteria,
    chart_fundamental_series, chart_data_flags, updated_at
  ) values (
    v_row.ticker, v_row.score_fundamental, v_row.score_total, v_row.criteria,
    v_row.chart_data -> 'fundamentalSeries', v_row.chart_data -> 'data_flags',
    v_row.updated_at
  )
  on conflict (ticker) do nothing;   -- erste Sicherung gewinnt

  perform set_config('app.keep_updated_at', 'on', true);

  update public.stock_analyses set
    score_fundamental = p_score_fundamental,
    score_total       = p_score_total,
    criteria          = p_criteria,
    chart_data        = p_chart_data
  where ticker = p_ticker;

  return jsonb_build_object(
    'ticker', p_ticker,
    'score_fundamental_alt', v_row.score_fundamental,
    'score_total_alt', v_row.score_total,
    'updated_at', v_row.updated_at
  );
end;
$$;

revoke all on function public.apply_fundamental(text, timestamptz, numeric, numeric, jsonb, jsonb)
  from public, anon, authenticated;

comment on function public.apply_fundamental(text, timestamptz, numeric, numeric, jsonb, jsonb) is
  'Schreibt einen nachgerechneten Fundamentalscore. Sichert den Vorzustand nach '
  'fundamental_backup_20261025, haelt updated_at fest und bricht ab, wenn die Zeile '
  'zwischenzeitlich geaendert wurde. Nur Service-Role.';

-- Rueckweg. Zeilenweise wie rollback_trend3: die chart_data-Teile werden nur
-- zurueckgeschrieben, wenn sie gesichert wurden, statt fehlende Teile auf
-- JSON-null zu setzen.
create or replace function public.rollback_fundamental(p_tickers text[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.fundamental_backup_20261025;
  v_chart jsonb;
  v_count integer := 0;
begin
  perform set_config('app.keep_updated_at', 'on', true);

  for b in
    select * from public.fundamental_backup_20261025
     where p_tickers is null or ticker = any(p_tickers)
     order by ticker
  loop
    -- Nur, wenn seitdem keine neue Analyse lief: apply_fundamental laesst
    -- updated_at stehen, ein Analyse-Lauf setzt es neu. Ohne diese Bedingung
    -- wuerde der Rueckweg das Ergebnis einer spaeteren Analyse mit dem alten
    -- Stand ueberschreiben.
    select chart_data into v_chart from public.stock_analyses
     where ticker = b.ticker and updated_at is not distinct from b.updated_at
     for update;
    if not found then
      continue;
    end if;
    v_chart := coalesce(v_chart, '{}'::jsonb);
    if b.chart_fundamental_series is not null then
      v_chart := jsonb_set(v_chart, '{fundamentalSeries}', b.chart_fundamental_series, true);
    end if;
    if b.chart_data_flags is not null then
      v_chart := jsonb_set(v_chart, '{data_flags}', b.chart_data_flags, true);
    end if;

    update public.stock_analyses set
      score_fundamental = b.score_fundamental,
      score_total       = b.score_total,
      criteria          = b.criteria,
      chart_data        = v_chart
    where ticker = b.ticker;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.rollback_fundamental(text[]) from public, anon, authenticated;

comment on function public.rollback_fundamental(text[]) is
  'Stellt den Zustand vor dem Nachrechnen des Fundamentalscores wieder her (alle oder '
  'die genannten Ticker). updated_at bleibt unveraendert. Nur Service-Role.';
