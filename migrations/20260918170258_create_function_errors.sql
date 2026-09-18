-- Schlanke, generische Fehler-Log-Tabelle fuer Edge Functions ohne
-- Ticker-Bezug (save-api-keys, delete-account) - bewusst getrennt von
-- request_log, das ticker-zentriert ist und dessen Admin-Auswertungen
-- (Meistgesuchte Ticker, Fehlschlaege, Kontrolllaeufe) von einem echten
-- Aktien-Ticker pro Zeile ausgehen. user_id ist nullable, weil ein Fehler
-- theoretisch schon vor verifyUser() auftreten kann (z.B. beim
-- Request-Body-Parsing).
create table if not exists function_errors (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  user_id uuid,
  error_message text not null,
  created_at timestamptz not null default now()
);

alter table function_errors enable row level security;

create policy function_errors_select_admin
  on function_errors
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );
