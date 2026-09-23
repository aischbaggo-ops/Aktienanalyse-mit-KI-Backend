-- Zeitstempel, wann eine Zugangsanfrage per approve-access-request
-- (Admin.inviteUserByEmail) tatsaechlich eine Einladungsmail ausgeloest hat.
-- NULL bleibt bei "abgelehnt" oder bei einer noch offenen Anfrage.
alter table access_requests
  add column if not exists invited_at timestamptz;
