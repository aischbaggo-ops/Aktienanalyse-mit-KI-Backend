-- Freischaltung einzelner Bausteine (Features) pro Nutzer. Keine Zeile =
-- nicht freigeschaltet (sicherer Default). Vorerst vergibt ein Admin manuell;
-- die Tabelle ist so gewaehlt, dass ein spaeterer Checkout (z. B. Stripe)
-- dieselben Zeilen schreiben kann, ohne Umbau.
create table if not exists feature_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null,
  unlocked boolean not null default false,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz,
  primary key (user_id, feature)
);

alter table feature_access enable row level security;

create policy feature_access_select_own
  on feature_access
  for select
  to authenticated
  using (auth.uid() = user_id);

-- Admins duerfen alle Zeilen lesen und schreiben (gleiches is_admin-Muster
-- wie request_log/search_log/function_errors).
create policy feature_access_admin_all
  on feature_access
  for all
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  )
  with check (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );
