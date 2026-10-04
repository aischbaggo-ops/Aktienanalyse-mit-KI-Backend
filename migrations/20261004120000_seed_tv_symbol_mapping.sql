-- Initiale Befuellung der tv_symbol_mapping-Tabelle.
-- Quelle: TradingView search-symbols (04.10.2026), Abgleich gegen
-- stock_analyses + watchlists + seed_index_constituents.
--
-- Regeln:
--   - Nur type = stock (keine DRs, Fonds, Crypto)
--   - Deutsche Werte: XETR als kanonischer Handelsplatz
--   - US-Werte: NYSE oder NASDAQ (tatsaechlicher Listing-Platz)
--   - Firmenname aus TradingView-Suche
--   - confirmed = true: eindeutiger Treffer, Name passt
--   - confirmed = false: Zuordnung plausibel, aber manuell pruefen
--
-- Nicht zugeordnet (kein stock-Treffer):
--   BTC      (AMEX:BTC = Grayscale Bitcoin Mini Trust ETF, type fund)
--   HENKY    (OTC:HENKY = Henkel ADR, type dr — HEN3.DE deckt Henkel ab)
--   NQUSD    (Crypto-Paar, kein TradingView-Stock)
--   WALLETUSD (Crypto-Paar, kein TradingView-Stock)
--   MA.BA    (Buenos-Aires-Listing, nur als DR gefunden)
--   TSRO     (Null Ergebnisse bei search-symbols)

insert into tv_symbol_mapping (fmp_ticker, tv_symbol, exchange, instrument_type, company_name, match_source, confirmed)
values
  -- US-Werte (confirmed)
  ('A',       'NYSE:A',       'NYSE',   'stock', 'Agilent Technologies, Inc.',              'auto', true),
  ('AAPL',    'NASDAQ:AAPL',  'NASDAQ', 'stock', 'Apple Inc.',                              'auto', true),
  ('ABT',     'NYSE:ABT',     'NYSE',   'stock', 'Abbott Laboratories',                     'auto', true),
  ('ACN',     'NYSE:ACN',     'NYSE',   'stock', 'Accenture Plc',                           'auto', true),
  ('ADBE',    'NASDAQ:ADBE',  'NASDAQ', 'stock', 'Adobe Inc.',                              'auto', true),
  ('AES',     'NYSE:AES',     'NYSE',   'stock', 'The AES Corporation',                     'auto', true),
  ('AFL',     'NYSE:AFL',     'NYSE',   'stock', 'Aflac Incorporated',                      'auto', true),
  ('AMC',     'NYSE:AMC',     'NYSE',   'stock', 'AMC Entertainment Holdings, Inc.',        'auto', true),
  ('AMD',     'NASDAQ:AMD',   'NASDAQ', 'stock', 'Advanced Micro Devices, Inc.',            'auto', true),
  ('AMZN',    'NASDAQ:AMZN',  'NASDAQ', 'stock', 'Amazon.com, Inc.',                        'auto', true),
  ('AOS',     'NYSE:AOS',     'NYSE',   'stock', 'A. O. Smith Corporation',                 'auto', true),
  ('APD',     'NYSE:APD',     'NYSE',   'stock', 'Air Products and Chemicals, Inc.',        'auto', true),
  ('AXP',     'NYSE:AXP',     'NYSE',   'stock', 'American Express Company',                'auto', true),
  ('BA',      'NYSE:BA',      'NYSE',   'stock', 'The Boeing Company',                      'auto', true),
  ('BRK.B',   'NYSE:BRK.B',   'NYSE',   'stock', 'Berkshire Hathaway Inc.',                 'auto', true),
  ('CAT',     'NYSE:CAT',     'NYSE',   'stock', 'Caterpillar Inc.',                        'auto', true),
  ('CVX',     'NYSE:CVX',     'NYSE',   'stock', 'Chevron Corporation',                     'auto', true),
  ('DGX',     'NYSE:DGX',     'NYSE',   'stock', 'Quest Diagnostics Incorporated',          'auto', true),
  ('DIS',     'NYSE:DIS',     'NYSE',   'stock', 'The Walt Disney Company',                 'auto', true),
  ('GOOG',    'NASDAQ:GOOG',  'NASDAQ', 'stock', 'Alphabet Inc.',                           'auto', true),
  ('GOOGL',   'NASDAQ:GOOGL', 'NASDAQ', 'stock', 'Alphabet Inc.',                           'auto', true),
  ('GS',      'NYSE:GS',      'NYSE',   'stock', 'The Goldman Sachs Group, Inc.',           'auto', true),
  ('HD',      'NYSE:HD',      'NYSE',   'stock', 'The Home Depot, Inc.',                    'auto', true),
  ('HON',     'NASDAQ:HON',   'NASDAQ', 'stock', 'Honeywell International Inc.',            'auto', true),
  ('HOOD',    'NASDAQ:HOOD',  'NASDAQ', 'stock', 'Robinhood Markets, Inc.',                 'auto', true),
  ('IBM',     'NYSE:IBM',     'NYSE',   'stock', 'International Business Machines Corporation', 'auto', true),
  ('JNJ',     'NYSE:JNJ',     'NYSE',   'stock', 'Johnson & Johnson',                      'auto', true),
  ('JPM',     'NYSE:JPM',     'NYSE',   'stock', 'JP Morgan Chase & Co.',                  'auto', true),
  ('KO',      'NYSE:KO',      'NYSE',   'stock', 'Coca-Cola Company',                      'auto', true),
  ('LLY',     'NYSE:LLY',     'NYSE',   'stock', 'Eli Lilly and Company',                  'auto', true),
  ('MA',      'NYSE:MA',      'NYSE',   'stock', 'Mastercard Incorporated',                'auto', true),
  ('MCD',     'NYSE:MCD',     'NYSE',   'stock', 'McDonald''s Corporation',                'auto', true),
  ('META',    'NASDAQ:META',  'NASDAQ', 'stock', 'Meta Platforms, Inc.',                    'auto', true),
  ('MMM',     'NYSE:MMM',     'NYSE',   'stock', '3M Company',                             'auto', true),
  ('MRK',     'NYSE:MRK',     'NYSE',   'stock', 'Merck & Company, Inc.',                  'auto', true),
  ('MSFT',    'NASDAQ:MSFT',  'NASDAQ', 'stock', 'Microsoft Corporation',                  'auto', true),
  ('NFLX',    'NASDAQ:NFLX',  'NASDAQ', 'stock', 'Netflix, Inc.',                          'auto', true),
  ('NVDA',    'NASDAQ:NVDA',  'NASDAQ', 'stock', 'NVIDIA Corporation',                     'auto', true),
  ('O',       'NYSE:O',       'NYSE',   'stock', 'Realty Income Corporation',               'auto', true),
  ('ORCL',    'NYSE:ORCL',    'NYSE',   'stock', 'Oracle Corporation',                     'auto', true),
  ('PTC',     'NASDAQ:PTC',   'NASDAQ', 'stock', 'PTC Inc.',                               'auto', true),
  ('PWR',     'NYSE:PWR',     'NYSE',   'stock', 'Quanta Services, Inc.',                  'auto', true),
  ('Q',       'NYSE:Q',       'NYSE',   'stock', 'Qnity Electronics, Inc.',                'auto', true),
  ('RCL',     'NYSE:RCL',     'NYSE',   'stock', 'Royal Caribbean Cruises Ltd.',            'auto', true),
  ('RDDT',    'NYSE:RDDT',    'NYSE',   'stock', 'Reddit, Inc.',                           'auto', true),
  ('REG',     'NASDAQ:REG',   'NASDAQ', 'stock', 'Regency Centers Corporation',            'auto', true),
  ('RF',      'NYSE:RF',      'NYSE',   'stock', 'Regions Financial Corporation',          'auto', true),
  ('ROP',     'NASDAQ:ROP',   'NASDAQ', 'stock', 'Roper Technologies, Inc.',               'auto', true),
  ('RSG',     'NYSE:RSG',     'NYSE',   'stock', 'Republic Services, Inc.',                'auto', true),
  ('SPGI',    'NYSE:SPGI',    'NYSE',   'stock', 'S&P Global Inc.',                        'auto', true),
  ('TSLA',    'NASDAQ:TSLA',  'NASDAQ', 'stock', 'Tesla, Inc.',                            'auto', true),
  ('V',       'NYSE:V',       'NYSE',   'stock', 'Visa Inc.',                              'auto', true),
  ('VRT',     'NYSE:VRT',     'NYSE',   'stock', 'Vertiv Holdings, LLC',                   'auto', true),
  ('WMT',     'NASDAQ:WMT',   'NASDAQ', 'stock', 'Walmart Inc.',                           'auto', true),
  ('XOM',     'NYSE:XOM',     'NYSE',   'stock', 'ExxonMobil Holdings Corporation',        'auto', true),

  -- Deutsche Werte (confirmed, kanonischer Platz XETR)
  ('HEN3.DE', 'XETR:HEN3',   'XETR',   'stock', 'Henkel AG & Co. KGaA',                  'auto', true),
  ('RHM.DE',  'XETR:RHM',    'XETR',   'stock', 'Rheinmetall AG',                        'auto', true),

  -- Nicht eindeutig (confirmed = false, manuell pruefen)
  ('SLS',     'NASDAQ:SLS',   'NASDAQ', 'stock', 'SELLAS Life Sciences Group, Inc.',       'auto', false)

on conflict (fmp_ticker) do update set
  tv_symbol       = excluded.tv_symbol,
  exchange        = excluded.exchange,
  instrument_type = excluded.instrument_type,
  company_name    = excluded.company_name,
  match_source    = excluded.match_source,
  confirmed       = excluded.confirmed,
  updated_at      = now();
