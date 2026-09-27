-- check_log_event_rate_limit() ist SECURITY DEFINER und war per Default-
-- Grant fuer PUBLIC/anon/authenticated ueber PostgREST (/rest/v1/rpc/...)
-- direkt aufrufbar - damit liessen sich an log-event vorbei die Zaehler
-- beliebiger IPs hochtreiben (Logging gezielt unterdruecken) oder die
-- Tabelle fluten. Aufrufer ist ausschliesslich log-event ueber den
-- Service-Role-Client (_shared/rateLimit.ts), daher nur service_role.
-- Gleiches Muster wie touch_last_seen()/set_my_username().
revoke execute on function check_log_event_rate_limit(text, integer) from public, anon, authenticated;
grant execute on function check_log_event_rate_limit(text, integer) to service_role;
