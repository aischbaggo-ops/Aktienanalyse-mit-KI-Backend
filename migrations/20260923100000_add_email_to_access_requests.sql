-- Separates E-Mail-Pflichtfeld fuer Zugangsanfragen, getrennt vom freien
-- "contact"-Feld (das weiterhin Telefon/Messenger o.ae. erlaubt). email ist
-- die Adresse, an die approve-access-request die Einladung schickt.
--
-- Spalte ist bewusst NICHT "not null" auf Tabellenebene: Alt-Anfragen (vor
-- diesem Feld) haben kein email und muessen laut Auftrag nicht nachtraeglich
-- befuellt werden. Eine echte "not null"-Spalte wuerde entweder eine
-- Backfill-Pflicht fuer diese Zeilen erzwingen, oder - mit "not valid" beim
-- CHECK - jede KUENFTIGE Aenderung (z.B. status/invited_at beim Genehmigen
-- oder Ablehnen) an einer Alt-Zeile zum Scheitern bringen, da Postgres bei
-- jedem UPDATE die komplette Zeile gegen alle CHECKs neu prueft, nicht nur
-- die geaenderten Spalten. "Pflicht fuer neue Eintraege" wird stattdessen
-- ueber die Insert-RLS-Policy erzwungen (nur fuer INSERT relevant, betrifft
-- bestehende Zeilen nie) plus zusaetzlich durch approve-access-request und
-- das Frontend-Formular (siehe accessRequest.ts).
alter table access_requests
  add column if not exists email text;

-- Format-/Laengenpruefung, die alte NULL-Zeilen immer erfuellen (email is
-- null zaehlt als bestanden) - greift nur, wenn email gesetzt ist.
alter table access_requests
  add constraint access_requests_email_format
  check (email is null or (
    char_length(btrim(email)) between 1 and 254
    and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  ));

-- Ersetzt die bisherige Insert-Policy: zusaetzlich zu status = 'neu' muss
-- ab jetzt eine plausible E-Mail-Adresse mitgeschickt werden. Bestehende
-- Zeilen sind davon nicht betroffen (gilt nur fuer INSERT).
drop policy if exists access_requests_insert_public on access_requests;

create policy access_requests_insert_public
  on access_requests
  for insert
  to anon, authenticated
  with check (
    status = 'neu'
    and email is not null
    and char_length(btrim(email)) between 1 and 254
    and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'
  );
