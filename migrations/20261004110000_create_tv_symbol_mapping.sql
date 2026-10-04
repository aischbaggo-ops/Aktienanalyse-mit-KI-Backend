-- TradingView-Anbindung: Zuordnungstabelle FMP-Ticker <-> TradingView-Symbol.
-- Speichert NUR Bezeichner (Ticker, Boerse, Instrumententyp, Firmenname),
-- keine Kurse und keine Fundamentaldaten.
--
-- Lesen: nur Admins (is_admin). Schreiben: ausschliesslich ueber den
-- Service-Role-Key (Edge Functions / CLI), keine Policy fuer
-- authenticated INSERT/UPDATE/DELETE.

create table if not exists tv_symbol_mapping (
  fmp_ticker    text primary key,
  tv_symbol     text not null,
  exchange      text not null,
  instrument_type text not null default 'stock',
  company_name  text,
  match_source  text not null default 'auto',
  confirmed     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table tv_symbol_mapping enable row level security;

-- Lesen nur fuer Admins
create policy tv_symbol_mapping_select_admin
  on tv_symbol_mapping
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Kein INSERT/UPDATE/DELETE fuer authenticated - Schreiben laeuft
-- ausschliesslich ueber den Service-Role-Client.
