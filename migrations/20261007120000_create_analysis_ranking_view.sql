-- Flache Rangliste-Sicht ueber stock_analyses (ENTWURF, nicht eingespielt).
-- Laut Entscheidung erst nach dem US-Lauf einspielen. Urspruenglich
-- 20261006100000, am 07.10. auf einen Zeitstempel nach
-- 20261007100000 (Ticket f) umbenannt, damit ein normales db push reicht.
--
-- Zweck: Sortieren, Filtern und CSV-Export der Analysen, ohne dass das
-- Frontend JSON-Pfade aus chart_data/bewertung/criteria kennen muss. Enthaelt
-- bewusst keine Fehlertexte, Kosten oder Rohantworten und keine ganzen
-- JSON-Spalten - nur einzelne, daraus gelesene Werte.
--
-- 09.10.: logo_url und price ergaenzt (fuer die Analyse-Tabellen der App).
-- market_cap und price stammen von FMP: nur in der App anzeigen, nicht in
-- PDF- oder CSV-Export (FMP-Lizenzfrage offen).
--
-- security_invoker = true: die Sicht gilt mit den Rechten des Aufrufers, es
-- greift also die RLS von stock_analyses (select fuer authenticated) und
-- index_constituents (select fuer authenticated). anon hat keinen Zugriff.
--
-- Kriteriennamen sind die ASCII-transkribierten Namen aus
-- stock_analyses.criteria (siehe QUAL_WEIGHTS in _shared/llm/prompt.ts).
--
-- data_flags (chart_data.data_flags) gibt es erst fuer Laeufe NACH dem
-- Deploy der zugehoerigen analyse-Aenderung. Fuer aeltere Zeilen sind die
-- data_flags-Spalten NULL (unbekannt); benchmark_symbol ist dort '^GSPC'
-- (der Code nutzte schon immer nur diesen Index) und methodik_version 1.
create or replace view analysis_ranking
with (security_invoker = true) as
select
  a.ticker,
  a.company_name                                            as name,
  a.status,
  -- updated_at = Datum der gespeicherten Analyse: der Trigger aus
  -- 20261007100000 laesst es bei laufendem oder gescheitertem Refresh stehen.
  a.updated_at                                              as analysed_at,
  -- Letzter Lauf (Ticket f). 'error' bei status 'done' heisst: Refresh
  -- gescheitert, die gezeigten Werte stammen aus der aelteren Analyse.
  -- Bewusst ohne last_run_error_public (keine Fehlertexte in der Sicht).
  a.last_run_status,
  a.last_run_at,
  a.sector,
  a.chart_data->'profileMeta'->>'industry'                  as industry,
  a.currency,
  a.current_price                                           as price,
  a.chart_data->'profileMeta'->>'image'                     as logo_url,
  a.chart_data->'profileMeta'->>'exchange'                  as exchange,
  (a.chart_data->'profileMeta'->>'marketCap')::numeric      as market_cap,
  a.chart_data->'quickCheck'->'marktkap_klasse'->>'klasse'  as cap_class,

  a.score_total,
  a.score_fundamental,
  a.score_qualitaet,
  -- Seit 07.10. NULL statt neutral, wenn die Kursreihe der Aktie fuer alle
  -- Krisenfenster bzw. alle Jahresrenditen zu kurz ist.
  a.score_krise,
  a.score_trend,
  a.score_stabilitaet,

  -- K.O.-Auswertung. no_go_hart ist das LLM-Flag (Prompt: nur echter Betrug).
  coalesce((a.chart_data->>'no_go_hart')::boolean, false)   as no_go_hart,

  -- Anzahl roter K.O.-Kriterien, dieselben vier Namen wie in der App
  -- (QualitaetTab.tsx KO_NAMES, seit Frontend-#26 inkl. "Geschaeftsmodell
  -- verstanden"). K.O. ist nur Flag und Filter, kein Deckel auf den Score.
  (select count(*)
     from jsonb_array_elements(a.criteria) c
    where c->>'dimension' = 'Qualitaet'
      and c->>'ampel' = 'rot'
      and c->>'name' in (
        'Geschaeftsmodell verstanden',
        'Keine Skandale',
        'Keine schweren Vorwuerfe gegen Unternehmen',
        'Keine schweren Vorwuerfe gegen Management'
      ))                                                    as ko_count,

  -- Wie viele dieser K.O.-Kriterien nicht bewertbar waren (grau): Blindstellen.
  (select count(*)
     from jsonb_array_elements(a.criteria) c
    where c->>'dimension' = 'Qualitaet'
      and c->>'ampel' = 'grau'
      and c->>'name' in (
        'Geschaeftsmodell verstanden',
        'Keine Skandale',
        'Keine schweren Vorwuerfe gegen Unternehmen',
        'Keine schweren Vorwuerfe gegen Management'
      ))                                                    as ko_unbewertet,

  -- K.O.-Warnung dynamischer Verschuldungsgrad (Netto-Schulden/FCF >= 10
  -- Jahre): entsteht als Warnungstext in warnings (scoring.ts), nicht als
  -- Kriterium.
  exists (select 1
            from jsonb_array_elements_text(a.warnings) w
           where w like 'Dynamischer Verschuldungsgrad zweistellig%')
                                                            as ko_verschuldung,

  -- Ampel des Kriteriums "Nachrichtenlage positiv" (grau = ohne News).
  (select c->>'ampel'
     from jsonb_array_elements(a.criteria) c
    where c->>'name' = 'Nachrichtenlage positiv'
    limit 1)                                                as news_ampel,

  -- true: K.O.-Kriterien mit aktuellen News bewertet; false: ohne News
  -- (blocked/error/empty); NULL: unbekannt (Zeile vor data_flags).
  case
    when a.chart_data->'data_flags' is null then null
    else (a.chart_data->'data_flags'->>'news_status') = 'ok'
  end                                                       as ko_geprueft,

  a.chart_data->'data_flags'->>'news_status'                as news_status,
  (a.chart_data->'data_flags'->>'news_count')::int          as news_count,
  (a.chart_data->'data_flags'->>'price_points')::int        as price_points,
  (a.chart_data->'data_flags'->>'estimates_count')::int     as estimates_count,
  a.chart_data->'data_flags'->>'reported_currency'          as reported_currency,
  coalesce(a.chart_data->'data_flags'->>'benchmark_symbol', '^GSPC')
                                                            as benchmark_symbol,
  coalesce((a.chart_data->'data_flags'->>'methodik_version')::smallint, 1)
                                                            as methodik_version,
  a.data_source,

  a.bewertung->'valuation'->'fair_value'->>'label'          as valuation_label,
  (a.bewertung->'valuation'->'fair_value'->>'abweichung_pct')::numeric
                                                            as valuation_dev,

  -- Mitgliedschaft in den aktivierten Indizes (Tabelle index_constituents).
  (select array_agg(ic.index_id order by ic.index_id)
     from index_constituents ic
    where ic.ticker = a.ticker
      and ic.index_id in ('sp500', 'nasdaq100', 'dowjones'))
                                                            as indices
from stock_analyses a;

revoke all on analysis_ranking from public, anon, authenticated;
grant select on analysis_ranking to authenticated;
