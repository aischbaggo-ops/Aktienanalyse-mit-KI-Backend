-- IP-basiertes Rate-Limit fuer log-event. log-event hat bewusst KEINEN
-- Auth-Check (siehe Kommentar in functions/log-event/index.ts - genau die
-- "stillen" Fehlschlaege ohne gueltige Session sollen geloggt werden
-- koennen), ist dadurch aber ohne jeden Schutz vor Flooding. Grosszuegiges
-- Limit (30/Minute/IP) - Zweck ist NICHT, echtes Logging zu blockieren,
-- sondern zu verhindern, dass jemand app_events mit Fake-Eintraegen flutet
-- und dadurch echte Angriffssignale im Rauschen versteckt.
--
-- Feste Minuten-Buckets (statt gleitendem Fenster) - einfach, ohne
-- zusaetzliche Extension, und fuer den Grosszuegigkeits-Zweck hier
-- ausreichend genau (schlimmstenfalls kurzzeitig ~2x Limit an einer
-- Bucket-Grenze).
create table if not exists log_event_rate_limit (
  ip text not null,
  minute_bucket timestamptz not null,
  count integer not null default 0,
  primary key (ip, minute_bucket)
);

alter table log_event_rate_limit enable row level security;

-- Gleiches is_admin-Muster wie api_call_log/app_events - Schreiben
-- ausschliesslich ueber check_log_event_rate_limit() (security definer)
-- via Service-Role-Client in der Function.
drop policy if exists log_event_rate_limit_select_admin on log_event_rate_limit;
create policy log_event_rate_limit_select_admin
  on log_event_rate_limit
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Atomarer Check-and-Increment (Race-sicher durch on conflict ... do
-- update ... returning, kein read-then-write in der Function). Raeumt bei
-- jedem Aufruf nebenbei alte Buckets auf (>10 Minuten) - kein separater
-- pg_cron-Job noetig, Tabelle bleibt dadurch klein.
create or replace function check_log_event_rate_limit(p_ip text, p_limit integer default 30)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count integer;
begin
  delete from log_event_rate_limit where minute_bucket < now() - interval '10 minutes';

  insert into log_event_rate_limit (ip, minute_bucket, count)
  values (p_ip, v_bucket, 1)
  on conflict (ip, minute_bucket)
  do update set count = log_event_rate_limit.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;
