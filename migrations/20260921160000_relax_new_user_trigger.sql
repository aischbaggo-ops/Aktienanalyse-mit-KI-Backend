-- Ein fehlender Nutzername bricht die Kontoerstellung nicht mehr ab: Konten,
-- die ohne Metadaten entstehen (z. B. "Add user" im Supabase-Dashboard),
-- bekommen username = NULL und waehlen beim ersten Login ueber den Dialog
-- (RPC set_my_username) selbst einen. Ist ein Name mitgegeben, gelten Format
-- und Eindeutigkeit weiterhin serverseitig. is_admin wird nie aus den
-- Client-Metadaten uebernommen.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text := nullif(trim(new.raw_user_meta_data->>'username'), '');
begin
  if v_username is not null then
    if v_username !~ '^[A-Za-z0-9_-]{3,24}$' then
      raise exception 'Nutzername ist ungueltig (3-24 Zeichen: Buchstaben, Zahlen, _ oder -)';
    end if;
    if exists (select 1 from profiles where lower(username) = lower(v_username)) then
      raise exception 'Nutzername bereits vergeben';
    end if;
  end if;
  insert into profiles (id, username) values (new.id, v_username)
  on conflict (id) do nothing;
  return new;
end;
$$;
