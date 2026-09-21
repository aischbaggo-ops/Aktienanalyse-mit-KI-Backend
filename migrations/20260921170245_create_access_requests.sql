-- Zugangsanfragen von Interessenten (Registrierung ist serverseitig gesperrt,
-- Accounts legt der Admin manuell an). Jeder darf eine Anfrage einreichen,
-- lesen und aendern duerfen nur Admins.
create table if not exists access_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  contact text not null,
  message text,
  status text not null default 'neu'
    check (status in ('neu', 'erledigt', 'abgelehnt')),
  created_at timestamptz not null default now(),
  -- Kein Rate-Limit/Captcha vorgesehen; die Laengenbegrenzung verhindert
  -- wenigstens, dass ueber den oeffentlichen Insert riesige Texte landen.
  constraint access_requests_contact_len check (char_length(btrim(contact)) between 1 and 200),
  constraint access_requests_name_len check (name is null or char_length(name) <= 100),
  constraint access_requests_message_len check (message is null or char_length(message) <= 2000)
);

alter table access_requests enable row level security;

-- Auch ohne Login einreichbar. status wird erzwungen auf 'neu', damit ein
-- Absender nicht direkt einen anderen Status setzen kann.
create policy access_requests_insert_public
  on access_requests
  for insert
  to anon, authenticated
  with check (status = 'neu');

-- Lesen und Aendern nur fuer Admins (gleiches is_admin-Muster wie request_log).
create policy access_requests_select_admin
  on access_requests
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

create policy access_requests_update_admin
  on access_requests
  for update
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
