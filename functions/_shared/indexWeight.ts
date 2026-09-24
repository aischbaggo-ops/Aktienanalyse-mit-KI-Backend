// UNGETESTET IN DER ECHTEN DENO-RUNTIME (hier nicht verfuegbar) - Parsing-
// Logik gegen die echten heruntergeladenen Dateien mit SheetJS/Node
// verifiziert (siehe Kommentare unten), aber ob SheetJS ueber esm.sh in
// Supabase Edge Functions genauso funktioniert wie in Node, ist nicht
// bestaetigt. Faengt getDowJonesWeight() abbricht das nur den Dow-Jones-
// Teil ab (try/catch), nicht die Analyse-Seite insgesamt.
import * as XLSX from "https://esm.sh/xlsx@0.18.5";

// Live-Abruf oeffentlicher ETF-Holdings-Dateien fuer die Index-Gewichtungs-
// Info-Anzeige (siehe index-weight/index.ts). Rein informativ - kein
// Einfluss auf Score/Sortierung, keine Speicherung (Auftrag). Jede Funktion
// hier gibt bei JEDEM Fehler (Netzwerk, Formataenderung, Ticker nicht
// gefunden) einfach null zurueck statt zu werfen - der Aufrufer laesst die
// betroffene Zeile dann stillschweigend weg.
//
// Quellen recherchiert und live verifiziert am 2026-09-24 (echte
// Downloads + lokales Parsing, nicht nur Trainingswissen):
// - S&P 500: iShares Core S&P 500 ETF (IVV). Oeffentliche CSV mit allen
//   500+ Konstituenten und einer "Weight (%)"-Spalte, funktioniert sauber.
// - Dow Jones: SPDR Dow Jones Industrial Average ETF (DIA). Oeffentliche
//   XLSX (ein Sheet "holdings") mit allen 30 Konstituenten inkl. eigener
//   Ticker-Spalte - Weight ist bereits eine Prozentzahl (10.88 = 10.88%),
//   keine Umrechnung noetig. Eine Zeile "US DOLLAR" (Cash-Anteil) wird
//   ueber die Ticker-Suche automatisch ignoriert, da kein echter Ticker.
// - NASDAQ 100: KEINE zuverlaessige kostenlose Quelle mit echter
//   Gewichtung gefunden. Invescos QQQ-Seite zeigt Holdings nur ueber ein
//   JS-Widget ohne auffindbaren CSV-/JSON-Export; Nasdaqs eigene API
//   (api.nasdaq.com) liefert nur Marktkapitalisierung, keine offizielle
//   Gewichtung - waere nur eine SELBST BERECHNETE Naeherung, die seit der
//   Methodik-Aenderung des Nasdaq-100 zum 1.5.2026 (siehe QQQ-Produktseite)
//   nicht mehr zuverlaessig mit der echten Gewichtung uebereinstimmen
//   muss. getNasdaq100Weight() liefert deshalb bewusst IMMER null, statt
//   eine ggf. falsche Zahl als "Gewichtung" auszugeben.

const IVV_HOLDINGS_URL =
  "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv";
const DIA_HOLDINGS_URL =
  "https://www.ssga.com/us/en/individual/library-content/products/fund-data/etfs/us/holdings-daily-us-en-dia.xlsx";

// Minimaler CSV-Zeilen-Parser mit Anfuehrungszeichen-Unterstuetzung (Werte
// wie "73,181,935,024.56" enthalten Kommas innerhalb von Anfuehrungs-
// zeichen) - keine externe Bibliothek noetig fuer dieses einfache Format.
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

export async function getSp500Weight(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(IVV_HOLDINGS_URL);
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    // Die Datei hat vorangestellte Fonds-Metadaten (Name, Datum, ...) -
    // die eigentliche Tabelle beginnt erst bei dieser Kopfzeile.
    const headerIdx = lines.findIndex((l) => l.startsWith("Ticker,Name"));
    if (headerIdx === -1) return null;
    const header = parseCsvLine(lines[headerIdx]);
    const tickerCol = header.indexOf("Ticker");
    const weightCol = header.indexOf("Weight (%)");
    if (tickerCol === -1 || weightCol === -1) return null;

    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCsvLine(lines[i]);
      if ((cols[tickerCol] ?? "").trim().toUpperCase() === ticker) {
        const weight = parseFloat(cols[weightCol]);
        return Number.isFinite(weight) ? weight : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Siehe Kommentar am Dateianfang - bewusst immer null, keine unzuverlaessige
// Naeherung. ticker unbenutzt, Signatur bleibt konsistent zu den anderen
// beiden Funktionen (einheitlicher Aufruf in index-weight/index.ts).
export function getNasdaq100Weight(_ticker: string): Promise<number | null> {
  return Promise.resolve(null);
}

export async function getDowJonesWeight(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(DIA_HOLDINGS_URL);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });

    // Per Header-Erkennung (Zeile mit "Ticker" UND "Weight") statt fixer
    // Zeilennummer suchen - bei der Verifikation war es Zeile 5 (Index 4)
    // im einzigen Sheet "holdings", kann sich aber mit einer kuenftigen
    // Datei-Version verschieben.
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" }) as unknown[][];
      const headerIdx = rows.findIndex(
        (r) => r.map(String).includes("Ticker") && r.map(String).includes("Weight"),
      );
      if (headerIdx === -1) continue;
      const header = rows[headerIdx].map(String);
      const tickerCol = header.indexOf("Ticker");
      const weightCol = header.indexOf("Weight");

      for (let i = headerIdx + 1; i < rows.length; i++) {
        if (String(rows[i][tickerCol] ?? "").trim().toUpperCase() === ticker) {
          const weight = Number(rows[i][weightCol]);
          return Number.isFinite(weight) ? Math.round(weight * 100) / 100 : null;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
