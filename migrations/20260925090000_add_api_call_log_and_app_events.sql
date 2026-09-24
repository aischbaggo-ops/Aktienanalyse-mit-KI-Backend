-- Teil 1: Granulares Token-/Latenz-Tracking JEDES einzelnen API-Calls
-- (FMP + Claude/LLM), nicht nur aggregiert pro Analyse wie bisher
-- request_log. Admin-Dashboard aggregiert daraus selbst (Summe
-- Tokens/Kosten pro Tag/Anbieter) - hier nur die Rohdaten.
create table if not exists api_call_log (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  provider text not null,
  -- FMP: Endpoint-Pfad (z.B. "/profile"). Claude/LLM: Zweck (z.B.
  -- "qualitaet-analyse", "qualitaet-analyse-kontrolle", "admin-chat").
  call_type text,
  ticker text,
  success boolean not null,
  duration_ms integer not null,
  tokens_input integer,
  tokens_output integer,
  cost_usd numeric,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists api_call_log_created_at_idx on api_call_log (created_at);
create index if not exists api_call_log_provider_idx on api_call_log (provider, created_at);

alter table api_call_log enable row level security;

-- Gleiches is_admin-Muster wie request_log/function_errors - Schreiben
-- ausschliesslich ueber den Service-Role-Client in den Functions.
drop policy if exists api_call_log_select_admin on api_call_log;
create policy api_call_log_select_admin
  on api_call_log
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Teil 2: Allgemeines Ereignis-Log fuer "stille" Fehlschlaege (HTTP-
-- technisch erfolgreich, aber das eigentliche Ziel nicht erreicht - z.B.
-- Einladungsmail verschickt, aber nie ein Passwort gesetzt) und
-- sicherheitsrelevante Auffaelligkeiten. Bewusst kurze Aufbewahrung (7
-- Tage, siehe Cleanup-Job unten) - reine akute Fehlersuche, kein
-- Langzeit-Audit-Log wie request_log/stock_analyses.
create table if not exists app_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  function_name text not null,
  status text not null check (status in ('ok', 'failed', 'suspicious')),
  user_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_events_created_at_idx on app_events (created_at);
create index if not exists app_events_type_idx on app_events (event_type, created_at);

alter table app_events enable row level security;

drop policy if exists app_events_select_admin on app_events;
create policy app_events_select_admin
  on app_events
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Automatische Bereinigung (7 Tage) per pg_cron, falls die Extension im
-- Projekt verfuegbar ist - beide Bloecke sind bewusst fehlertolerant
-- (DO-Block faengt eine fehlende/nicht erlaubte Extension ab), damit ein
-- Projekt ohne pg_cron-Zugriff trotzdem den Rest dieser Migration
-- bekommt. Falls pg_cron hier nicht verfuegbar ist, siehe Kommentar in
-- functions/analyse/index.ts (Fallback-Bereinigung) - dort wird das nach
-- dem Deploy verifiziert und bei Bedarf ergaenzt.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron nicht verfuegbar, Migration laeuft ohne automatischen Cleanup-Job weiter: %', sqlerrm;
end $$;

do $$
begin
  perform cron.schedule(
    'cleanup_api_call_log_app_events',
    '0 4 * * *',
    $cron$
      delete from api_call_log where created_at < now() - interval '7 days';
      delete from app_events where created_at < now() - interval '7 days';
    $cron$
  );
exception when others then
  raise notice 'pg_cron-Job konnte nicht eingerichtet werden (Extension vermutlich nicht verfuegbar): %', sqlerrm;
end $$;
