-- Ersetzt das im urspruenglichen Pentest-Scratchpad vorgesehene Rate-Limit-
-- Muster (Zeilen in request_log/search_log/admin_chat_log per COUNT(*)
-- abfragen) durch dasselbe atomare Check-and-Increment-Muster wie bereits
-- bei log-event (siehe migrations/20260927170000_add_log_event_rate_limit.sql),
-- nur user_id- statt IP-basiert (analyse/symbol-search/admin-chat haben
-- alle einen Auth-Check, es gibt also immer eine echte userId).
--
-- Warum COUNT(*)-Abfragen nicht race-sicher sind: zwei parallele Requests
-- koennen beide "read" ausfuehren, BEIDE sehen einen Zaehlerstand unter dem
-- Limit, BEIDE fuehren die kostenpflichtige Aktion aus - das Limit wird
-- effektiv um 1 ueberschritten, bei genug Parallelitaet beliebig oft. Der
-- INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING-Ansatz hier ist
-- innerhalb einer einzelnen Postgres-Transaktion atomar, kein TOCTOU-Fenster.
--
-- EINE gemeinsame Tabelle/Funktion mit "scope"-Spalte statt drei separaten
-- (analog log_event_rate_limit) - vermeidet Kopien derselben Logik fuer
-- drei fast identische Limits (120/h analyse, 60/h symbol-search,
-- 30/h admin-chat).
--
-- Lehre aus Audit H2 (log_event_rate_limit's Funktion war anfangs oeffentlich
-- per REST aufrufbar): das EXECUTE-Recht wird hier von Anfang an NUR an
-- service_role vergeben, nicht erst nachtraeglich korrigiert.
create table if not exists user_rate_limit (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope text not null,
  hour_bucket timestamptz not null,
  count integer not null default 0,
  primary key (user_id, scope, hour_bucket)
);

alter table user_rate_limit enable row level security;

-- Gleiches is_admin-Muster wie api_call_log/app_events - Schreiben
-- ausschliesslich ueber check_user_rate_limit() (security definer) via
-- Service-Role-Client in den jeweiligen Functions.
drop policy if exists user_rate_limit_select_admin on user_rate_limit;
create policy user_rate_limit_select_admin
  on user_rate_limit
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- Atomarer Check-and-Increment, race-sicher durch on conflict ... do
-- update ... returning (kein read-then-write in der Function). Raeumt bei
-- jedem Aufruf nebenbei alte Buckets auf (>2 Stunden) - kein separater
-- pg_cron-Job noetig, Tabelle bleibt dadurch klein.
create or replace function check_user_rate_limit(p_user_id uuid, p_scope text, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz := date_trunc('hour', now());
  v_count integer;
begin
  delete from user_rate_limit where hour_bucket < now() - interval '2 hours';

  insert into user_rate_limit (user_id, scope, hour_bucket, count)
  values (p_user_id, p_scope, v_bucket, 1)
  on conflict (user_id, scope, hour_bucket)
  do update set count = user_rate_limit.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

-- Wie bei check_log_event_rate_limit(): kein Default-Grant fuer
-- public/anon/authenticated stehen lassen. Aufrufer ist ausschliesslich
-- der jeweilige Service-Role-Client in _shared/rateLimit.ts.
revoke execute on function check_user_rate_limit(uuid, text, integer) from public, anon, authenticated;
grant execute on function check_user_rate_limit(uuid, text, integer) to service_role;
