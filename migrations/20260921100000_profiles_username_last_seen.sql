-- Nutzername (Pflicht bei neuen Registrierungen, Bestandskonten bleiben NULL)
-- und Online-Status (last_seen_at) auf profiles.
alter table profiles
  add column if not exists username text,
  add column if not exists last_seen_at timestamptz;

-- Format auch serverseitig erzwingen (Client-Validierung allein waere per API
-- umgehbar). NULL bleibt erlaubt, damit Bestandskonten nicht scheitern.
alter table profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[A-Za-z0-9_-]{3,24}$');

-- Eindeutigkeit ohne Gross-/Kleinschreibung ("Alice" = "alice").
create unique index if not exists profiles_username_lower_idx
  on profiles (lower(username));

-- Vorab-Pruefung fuer das Registrierungsformular (auch ohne Login aufrufbar).
create or replace function username_available(p_username text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select not exists (
    select 1 from profiles where lower(username) = lower(p_username)
  )
$$;
grant execute on function username_available(text) to anon, authenticated;

-- Legt bei jeder Registrierung die profiles-Zeile an und erzwingt dabei
-- Pflichtfeld, Format und Eindeutigkeit des Nutzernamens serverseitig.
-- is_admin bleibt bewusst auf dem Spalten-Default (false) - es wird NIE aus
-- den vom Client mitgeschickten Metadaten uebernommen.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text := trim(new.raw_user_meta_data->>'username');
begin
  if v_username is null or v_username !~ '^[A-Za-z0-9_-]{3,24}$' then
    raise exception 'Nutzername fehlt oder ist ungueltig (3-24 Zeichen: Buchstaben, Zahlen, _ oder -)';
  end if;
  if exists (select 1 from profiles where lower(username) = lower(v_username)) then
    raise exception 'Nutzername bereits vergeben';
  end if;
  insert into profiles (id, username) values (new.id, v_username)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Heartbeat: schreibt ausschliesslich last_seen_at der eigenen Zeile
-- (auth.uid()). Bewusst als RPC statt einer UPDATE-Policy auf profiles -
-- eine UPDATE-Policy wuerde dem Nutzer erlauben, auch is_admin der eigenen
-- Zeile zu setzen. Legt die Zeile an, falls ein Bestandskonto noch keine hat.
create or replace function touch_last_seen()
returns void
language sql
security definer
set search_path = public
as $$
  insert into profiles (id, last_seen_at) values (auth.uid(), now())
  on conflict (id) do update set last_seen_at = now()
$$;
revoke execute on function touch_last_seen() from public, anon;
grant execute on function touch_last_seen() to authenticated;
