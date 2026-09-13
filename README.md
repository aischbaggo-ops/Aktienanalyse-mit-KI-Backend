# Supabase Edge Functions — `analyse` + `symbol-search`

Ersetzt die zwei n8n-Workflows ("Aktienanalyse" + "Ticker-Suche"). Die komplette
Rechenlogik (Fundamental/Krise/Trend), der Claude-Prompt, das
Plausibilitäts-/Kontrolllauf-System und die Kostenberechnung sind 1:1 aus dem
laufenden n8n-Workflow übernommen, nur nach Deno/TypeScript übersetzt — nichts
wurde neu erfunden oder verändert.

## Dateistruktur

```
supabase/
├── config.toml                      # verify_jwt-Einstellungen pro Function
└── functions/
    ├── _shared/
    │   ├── cors.ts
    │   ├── scoring.ts                # Score: Deterministisch (F, K, T)
    │   └── claude.ts                 # Prompt, Gewichte, Pricing, Claude-Call
    ├── analyse/index.ts              # Haupt-Function
    └── symbol-search/index.ts        # FMP-Symbolsuche
```

## Was ich (Claude Code) bereits gemacht habe

- Alle Dateien exakt nach Vorgabe angelegt (Code unverändert übernommen).
- In `analyse/index.ts` zusätzliche `console.log`-Marker vor der Response und
  am Start/Ende von `runAnalysis()` ergänzt — rein für Prüfpunkt 3 unten, ändert
  an der Logik nichts.
- `config.toml` mit `verify_jwt = false` für beide Functions vorbereitet (siehe
  Prüfpunkt 2 unten — Begründung dort).
- **Kein lokales Testen über `supabase start` / `supabase functions serve`**
  mehr (das hattest du gestoppt, da es Docker braucht und dafür hier nicht
  nötig ist). Ich habe die dafür angelegten Docker-Container wieder sauber
  entfernt (`supabase stop`) und die temporäre Test-Function gelöscht — im
  Repo liegt nur noch die finale Dateistruktur oben.
- Zu Prüfpunkt 1 und 2 die aktuelle Supabase-Doku recherchiert (Stand jetzt,
  nicht aus Trainingsdaten geraten) — Ergebnisse unten bei den jeweiligen
  Punkten.

Alles Weitere unten musst du auf deinem eigenen Rechner ausführen (Node.js ist
dort laut dir schon installiert).

---

## Schritt 1 — Supabase CLI installieren

**Wichtig:** `npm install -g supabase` (wie in der ursprünglichen Notiz)
**funktioniert auf Windows nicht mehr** — Supabase blockiert das seit einiger
Zeit aktiv mit der Fehlermeldung *"Installing Supabase CLI as a global module
is not supported"* (PATH-Probleme, kaputte Installationen nach Node-Updates
etc. waren der Grund). Zwei funktionierende Alternativen:

**Option A — als Projekt-Abhängigkeit (empfohlen, kein zusätzliches Tool nötig):**

```bash
cd "Investment mit KI/KI Aktienanalyse"
npm install -D supabase
```

Danach jeden Befehl über `npx supabase ...` aufrufen (z.B. `npx supabase login`
statt `supabase login`). Das ist der Weg, den ich in dieser Session selbst
erfolgreich genutzt habe (nur eben nicht für den jetzt gestoppten lokalen Test).

**Option B — über Scoop (von Supabase für Windows empfohlen, globaler Befehl):**

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Falls du Scoop nicht installiert hast, ist Option A schneller. Im Rest dieser
Anleitung gehe ich von Option A aus (`npx supabase`) — bei Option B einfach
`npx supabase` durch `supabase` ersetzen.

## Schritt 2 — Anmelden (musst du selbst machen, Browser-Login)

```bash
npx supabase login
```

Öffnet den Browser für die Anmeldung — das kann ich nicht für dich erledigen.

## Schritt 3 — Projekt verlinken

```bash
cd "Investment mit KI/KI Aktienanalyse"
npx supabase link --project-ref lthzvefqwhyiynescyhq
```

(Die `project_id` in `config.toml` ist bereits auf `lthzvefqwhyiynescyhq`
gesetzt.)

## Schritt 4 — Secrets setzen (niemals ins Repo committen)

```bash
npx supabase secrets set FMP_API_KEY=<der bekannte FMP-Key>
npx supabase secrets set ANTHROPIC_API_KEY=<der bekannte Anthropic-Key>
```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` sind in Edge Functions bereits
automatisch vorhanden, nichts weiter zu tun.

## Schritt 5 — Deployen

```bash
npx supabase functions deploy analyse
npx supabase functions deploy symbol-search
```

Danach erreichbar unter:

```
https://lthzvefqwhyiynescyhq.supabase.co/functions/v1/analyse
https://lthzvefqwhyiynescyhq.supabase.co/functions/v1/symbol-search
```

---

## Danach: die drei offenen Prüfpunkte — jetzt gegen das echte Projekt

Da lokales Testen entfällt, hier die konkreten Schritte, um alle drei **live**
zu verifizieren, bevor das Frontend umgestellt wird.

### Prüfpunkt 1 — `EdgeRuntime.waitUntil()`

Laut aktueller Supabase-Doku (`supabase.com/docs/guides/functions/background-tasks`,
gerade nachgeschlagen, nicht aus altem Wissen geraten) ist `EdgeRuntime.waitUntil(promise)`
tatsächlich die korrekte, aktuelle API dafür — Signatur, Verhalten und die
Empfehlung "nicht awaiten" passen zum Code in `analyse/index.ts`. Das ist also
grundsätzlich korrekt verwendet.

**Trotzdem real testen, so geht's ohne Zusatz-Tooling:**

1. Nach dem Deploy einen Testaufruf machen, der garantiert NICHT aus dem Cache
   kommt (frischer Ticker oder `force_refresh: true`):
   ```bash
   curl -X POST https://lthzvefqwhyiynescyhq.supabase.co/functions/v1/analyse \
     -H "Content-Type: application/json" \
     -d '{"ticker":"AAPL","user_id":null,"max_age_days":7,"force_refresh":true}' \
     -w "\nZeit bis Response: %{time_total}s\n"
   ```
2. Die Analyse dauert laut Frontend-Text "ca. 20–40 Sekunden". Wenn `waitUntil()`
   funktioniert, zeigt `%{time_total}` **weit unter einer Sekunde** (nur die Zeit
   bis `{"source":"processing",...}` zurückkommt) — nicht 20–40s.
3. In `stock_analyses` in der Datenbank nachsehen: `status` sollte sofort
   `running` sein, und nach ~20–40s auf `done` wechseln (z.B. per SQL-Editor im
   Supabase Dashboard oder einfach in der App unter `/analyse/AAPL` beobachten).
4. Logs prüfen (siehe Prüfpunkt 3) — dort müssen die Zeilen
   `[analyse] responding immediately...` und einige Sekunden später
   `[analyse] background run finished...` auftauchen. Genau dieser zeitliche
   Abstand zwischen beiden Log-Zeilen ist der Beweis, dass der Hintergrundteil
   wirklich weiterläuft, nachdem die Response schon raus ist.

Falls Schritt 2 stattdessen ~20–40s dauert: `waitUntil()` greift nicht (z.B.
falsche Deploy-Konfiguration) — dann bitte den Fehler/die Logs an mich zurückgeben.

### Prüfpunkt 2 — JWT-Pflicht der Functions

Bestätigt (aktuelle Doku, `supabase.com/docs/guides/functions/auth`): **Standardmäßig
ist `verify_jwt = true` aktiv** — ohne explizite Konfiguration blockiert die
Plattform anonyme Aufrufe mit 401, bevor der Function-Code überhaupt läuft. Das
hätte genau das Problem verursacht, vor dem du gewarnt hast (die "Anonym"-Einträge
im Request-Log wären dann nicht mehr möglich gewesen, da das Frontend aktuell
keinen Supabase-JWT an die Webhooks mitschickt).

Ich habe deshalb `supabase/config.toml` mit
```toml
[functions.analyse]
verify_jwt = false

[functions.symbol-search]
verify_jwt = false
```
vorbereitet — das wird beim Deploy automatisch angewendet.

**Wichtiger Vorbehalt, den ich beim Recherchieren gefunden habe:** Es gibt
mehrere offene Issues im `supabase/cli`-Repo, laut denen die `verify_jwt`-
Einstellung aus `config.toml` bei manchen Deploys **nicht zuverlässig
übernommen wird**. Bitte deshalb nach dem Deploy **zusätzlich im Dashboard
manuell prüfen**, nicht nur der Config-Datei vertrauen:

Supabase Dashboard → Edge Functions → `analyse` (und `symbol-search`) →
Settings → **"Enforce JWT Verification"** muss auf **AUS** stehen.

Konkreter Test: Ruf die Function mit `curl` **ohne** `Authorization`-Header auf
(wie im Beispiel bei Prüfpunkt 1) — kommt `401 Unauthorized` statt einer echten
Antwort, ist JWT-Pflicht noch aktiv und muss im Dashboard manuell ausgeschaltet
werden.

### Prüfpunkt 3 — Logs nach dem ersten Testlauf prüfen

Supabase Dashboard → Edge Functions → `analyse` → **Logs**. Nach dem Testaufruf
aus Prüfpunkt 1 solltest du dort (zeitlich in dieser Reihenfolge) sehen:

```
[analyse] responding immediately, handing off to background ticker=AAPL logId=...
[analyse] background run started ticker=AAPL logId=...
[analyse] background run finished ticker=AAPL logId=... status=done durationMs=...
```

Falls die dritte Zeile fehlt: der Hintergrundteil ist abgebrochen (Function-
Timeout, Fehler in `runAnalysis`) — dann sollte stattdessen eine
`[analyse] background run FAILED ...`-Zeile mit Fehlerdetails auftauchen, die
den Grund zeigt.

---

## Was danach noch übrig bleibt (bewusst noch nicht von mir angefasst)

- **Frontend auf die neuen URLs umstellen** — ich habe `frontend/.env` und
  `lib/webhooks.ts` absichtlich **nicht** angefasst. Die zeigen weiterhin auf
  die alten ngrok/n8n-Webhooks, bis du die drei Prüfpunkte oben live bestätigt
  hast. Erst danach `VITE_ANALYSE_WEBHOOK_URL` /
  `VITE_SYMBOL_SEARCH_WEBHOOK_URL` in `frontend/.env` auf die beiden
  `.../functions/v1/...`-URLs ändern (sag Bescheid, das mache ich dann).
- n8n-Workflow deaktivieren (nicht löschen — bleibt als Referenz/Fallback).
- ngrok-Tunnel wird danach überflüssig.
