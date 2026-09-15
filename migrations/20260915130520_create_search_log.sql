-- Eigenstaendige, minimale Log-Tabelle fuer symbol-search-Aufrufe -
-- bewusst getrennt von request_log statt dort mit reinzuschreiben, damit
-- die bestehenden Admin-Auswertungen (Meistgesuchte Ticker, Letzte
-- Anfragen, Kontrolllaeufe), die alle von request_log.ticker als echtem
-- Aktien-Ticker ausgehen, nicht durch Freitext-Suchanfragen verwaessert
-- werden. Dient dem Auslastungstracker im Admin-Dashboard als zweite,
-- separat ausgewiesene Datenquelle.
create table if not exists search_log (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  rate_limited boolean not null default false,
  requested_at timestamptz not null default now()
);

alter table search_log enable row level security;

create policy search_log_select_admin
  on search_log
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );
