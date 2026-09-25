-- Infrastruktur fuer Rate-Limiting (Pentest-Scratchpad M1): analyse nutzt
-- dafuer bereits request_log (hat user_id) - symbol-search und admin-chat
-- brauchen das noch.

-- search_log hatte bisher bewusst keine user_id (siehe Kommentar in
-- symbol-search/index.ts, Kontext war die Konto-Loeschung, nicht Teil
-- jenes Auftrags). Fuer ein Pro-Nutzer-Rate-Limit wird sie jetzt gebraucht -
-- on delete cascade loest das urspruengliche Bedenken gleich mit: die
-- Zeilen eines geloeschten Kontos verschwinden automatisch, kein
-- zusaetzlicher Code in delete-account noetig.
alter table search_log
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Bislang keine Persistenz fuer admin-chat-Aufrufe - fuer das Rate-Limit
-- und als Nebeneffekt ein Audit-Trail (wer hat wann den kostenpflichtigen
-- Recherche-Chat genutzt), gleiches Muster wie search_log/request_log.
create table if not exists admin_chat_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);

alter table admin_chat_log enable row level security;

create policy admin_chat_log_select_admin
  on admin_chat_log
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );
