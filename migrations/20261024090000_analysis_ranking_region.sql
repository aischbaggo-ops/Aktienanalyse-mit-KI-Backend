-- analysis_ranking: Spalte region anhaengen, DAX und MDAX in indices.
--
-- Michaels Entscheidung vom 20.10.2026: Rangliste getrennt nach Region.
-- Ein DAX-Wert wird seit Methodik 4 gegen ^GDAXI gemessen (sechs
-- Krisenfenster, 6 % CAGR-Schwelle), ein US-Wert gegen ^GSPC. Ein
-- Trendscore von 70 bedeutet also nicht dasselbe - ohne Trennung stuenden
-- beide in einer Tabelle nebeneinander.
--
-- create or replace view erlaubt nur, Spalten HINTEN anzuhaengen und
-- Ausdruecke zu aendern, nicht Reihenfolge oder Typ bestehender Spalten.
-- Der Rumpf ist deshalb Wort fuer Wort aus 20261007120000 uebernommen,
-- geaendert sind nur der indices-Filter und die neue letzte Spalte.
-- security_invoker und die Rechte bleiben wie gehabt; sie werden unten
-- trotzdem neu gesetzt, damit die Migration fuer sich allein stimmt.

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
  -- DAX und MDAX seit dem 24.10.2026; vorher fehlten sie hier, ein
  -- DAX-Wert haette in der Rangliste ohne Index gestanden.
  (select array_agg(ic.index_id order by ic.index_id)
     from index_constituents ic
    where ic.ticker = a.ticker
      and ic.index_id in ('sp500', 'nasdaq100', 'dowjones', 'dax', 'mdax'))
                                                            as indices,

  -- Region (Methodik 4). Bewertete Zeilen tragen sie in data_flags.
  -- Zeilen ohne Eintrag - Fehlerlaeufe und alles vor Methodik 4 - leiten
  -- sie aus der Indexzugehoerigkeit ab, in derselben Rangfolge wie
  -- resolveRegion() in _shared/region.ts: deutscher Index -> DE, sonst US.
  -- US als letzter Rueckfall ist richtig, weil bis Methodik 3 jede Aktie
  -- gegen den S&P gerechnet wurde.
  coalesce(
    a.chart_data->'data_flags'->>'region',
    case when exists (select 1 from index_constituents ic
                       where ic.ticker = a.ticker
                         and ic.index_id in ('dax', 'mdax', 'sdax'))
         then 'DE' else 'US' end
  )                                                         as region
from stock_analyses a;

revoke all on analysis_ranking from public, anon, authenticated;
grant select on analysis_ranking to authenticated;
