-- Pentest-Scratchpad M3: username_available() war an "anon, authenticated"
-- vergeben (Migration 20260921100000) - erlaubte Ticker-/Username-
-- Enumeration auch ohne Login. Grant auf authenticated beschraenkt; die
-- Funktion selbst bleibt unveraendert.
revoke execute on function username_available(text) from anon;
