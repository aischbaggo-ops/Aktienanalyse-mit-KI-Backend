-- Nachtrag zur Pentest-Dokumentation (H1/H2/H3): dokumentiert die
-- tatsaechlich live aktiven RLS-Policies auf drei Tabellen, die von vor
-- dieser Migrationshistorie stammen (profiles, request_log,
-- stock_analyses - keine CREATE-TABLE-Migration im Repo, siehe H1-
-- Kommentar in 20260923110000). Policy-Stand per Supabase Dashboard ->
-- Table Editor -> Policies, vom Nutzer am 2026-09-24 abgefragt und hier
-- per drop+create idempotent nachgezogen - KEINE Verhaltensaenderung,
-- reine Dokumentation. Die Tabellenstruktur selbst (Spalten/Constraints)
-- wird hier bewusst NICHT nachgebaut, da die vollstaendige Definition
-- nicht vorlag und nicht geraten werden sollte - nur die Policies, die
-- im Dashboard vollstaendig einsehbar waren.

alter table profiles enable row level security;
alter table request_log enable row level security;
alter table stock_analyses enable row level security;

-- profiles: einzige Policy ist SELECT fuer authenticated. KEINE
-- UPDATE-Policy vorhanden - RLS ist deny-by-default, ein Nutzer kann sein
-- eigenes profiles-Row daher schon allein dadurch nicht per PostgREST-PATCH
-- aendern. is_admin ist damit DOPPELT abgesichert: RLS verbietet das
-- UPDATE komplett, UND der Trigger aus 20260923110000 wuerde is_admin
-- zusaetzlich zuruecksetzen, falls doch einmal eine permissive
-- UPDATE-Policy ergaenzt wird. Aenderungen an eigenen Feldern (Username)
-- laufen bewusst ausschliesslich ueber die SECURITY DEFINER RPC
-- set_my_username() (20260921140000), nicht ueber eine allgemeine
-- UPDATE-Policy - absichtlich so gelassen, nicht ergaenzen.
drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own
  on profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- request_log: einzige Policy ist SELECT, admin-only (gleiches Muster wie
-- function_errors_select_admin/search_log_select_admin, siehe
-- 20260918170258/20260915130520). Kein INSERT/UPDATE/DELETE fuer
-- authenticated - Schreiben laeuft ausschliesslich ueber den
-- Service-Role-Client in analyse/index.ts, kein direkter Cross-User-
-- Schreibpfad ueber PostgREST fuer normale Nutzer.
drop policy if exists request_log_select_admin on request_log;
create policy request_log_select_admin
  on request_log
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.is_admin = true
    )
  );

-- stock_analyses: einzige Policy ist SELECT fuer ALLE authentifizierten
-- Nutzer (nicht "own") - das ist beabsichtigtes Design, kein fehlendes
-- user_id/Datenleck: die Tabelle ist ein von allen Nutzern geteilter,
-- tickerbasierter Analyse-Cache (siehe Kommentar zu admin_chat_context in
-- analyse/index.ts: "stock_analyses ist ein von ALLEN Nutzern geteilter
-- Cache"; und "Letzte Analysen (24h)" im Dashboard, die bewusst ALLE
-- Nutzer-Analysen zeigt, nicht nur eigene). Kein INSERT/UPDATE/DELETE fuer
-- authenticated - Schreiben laeuft ausschliesslich ueber den
-- Service-Role-Client in analyse/index.ts.
drop policy if exists stock_analyses_select_authenticated on stock_analyses;
create policy stock_analyses_select_authenticated
  on stock_analyses
  for select
  to authenticated
  using (true);
