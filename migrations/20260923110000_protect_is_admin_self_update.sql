-- Sicherheitsfix (Pentest-Scratchpad H1, kritisch): verhindert, dass ein
-- Nutzer sein eigenes is_admin selbst setzen kann, FALLS eine UPDATE-Policy
-- auf profiles existiert, die is_admin nicht explizit ausschliesst.
--
-- Es gibt im Repo KEINE CREATE-TABLE-Migration fuer profiles (die Tabelle
-- stammt aus der Zeit vor dieser Migrationshistorie) - die tatsaechlich
-- live aktiven RLS-Policies sind dadurch von hier aus nicht einsehbar
-- (kein Docker fuer "supabase db dump", kein direkter DB-Zugriff). Dieser
-- Trigger ist deshalb bewusst als Verteidigung UNABHAENGIG von der
-- jeweiligen Policy gebaut, nicht als Ersatz fuer die noch ausstehende
-- Live-Pruefung/Dokumentation der bestehenden Policies (siehe Chat-
-- Uebergabe - separat nachzuholen, sobald die Policy-Definitionen
-- tatsaechlich vorliegen).
--
-- Wirkung: Bei jedem UPDATE auf profiles wird is_admin auf den alten Wert
-- zurueckgesetzt, AUSSER der Aufrufer ist die service_role (z.B. eine Edge
-- Function mit Service-Role-Client, etwa eine kuenftige Admin-Verwaltungs-
-- Function). Greift zusaetzlich zu und unabhaengig von RLS - schliesst die
-- Rechteausweitung auch dann, wenn eine bestehende Policy is_admin nicht
-- ausschliesst.
create or replace function prevent_self_admin_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_admin is distinct from old.is_admin and auth.role() <> 'service_role' then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_admin_grant on profiles;

create trigger trg_prevent_self_admin_grant
  before update on profiles
  for each row
  execute function prevent_self_admin_grant();
