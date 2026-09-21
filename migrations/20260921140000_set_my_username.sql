-- Erlaubt Bestandskonten ohne Nutzername (username IS NULL), einmalig einen
-- Nutzernamen zu waehlen. Danach ist er nicht mehr aenderbar. Als RPC statt
-- UPDATE-Policy, damit ein Nutzer nie andere Spalten (is_admin) beschreiben
-- kann. Legt die profiles-Zeile an, falls sie noch fehlt.
create or replace function set_my_username(p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := trim(p_username);
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  if v is null or v !~ '^[A-Za-z0-9_-]{3,24}$' then
    raise exception 'Nutzername fehlt oder ist ungueltig (3-24 Zeichen: Buchstaben, Zahlen, _ oder -)';
  end if;

  insert into profiles (id) values (auth.uid()) on conflict (id) do nothing;

  if exists (select 1 from profiles where lower(username) = lower(v) and id <> auth.uid()) then
    raise exception 'Nutzername bereits vergeben';
  end if;

  update profiles set username = v where id = auth.uid() and username is null;
  if not found then
    raise exception 'Nutzername ist bereits gesetzt und kann nicht geaendert werden';
  end if;
end;
$$;
revoke execute on function set_my_username(text) from public, anon;
grant execute on function set_my_username(text) to authenticated;
