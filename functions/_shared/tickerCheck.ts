// Ticker-Pruefung gegen FMP-Profile, rein und ohne Netz (der Abruf wird als
// Funktion uebergeben). Genutzt von validate-tickers; die Schreibweisen-
// Varianten nutzt auch analyse.
//
// Warum Einzelabfragen: Die Sammelabfrage /profile?symbol=A,B,C lieferte im
// stabilen FMP-API keine verwertbare Trefferliste mehr, "Ticker erkennen"
// verwarf deshalb ALLE Eintraege. /profile?symbol=X (einzeln) ist dieselbe
// Abfrage, auf die analyse seit jeher aufbaut.
import { classifyFmpResult, type FmpClass, type FmpResultLike } from "./fmpStatus.ts";

// Referenz-Ticker: Liefert ein Lauf NUR leere Antworten, wird er einzeln
// nachgefragt. Kennt FMP auch AAPL nicht, ist die Pruefung kaputt (nicht die
// Ticker ungueltig).
export const CANARY_SYMBOL = "AAPL";

export type ProfileFetch = (symbol: string) => Promise<FmpResultLike>;

// FMP fuehrt Aktiengattungen je nach Endpunkt mit Punkt (BRK.B) oder
// Bindestrich (BRK-B). Die Eingabe zuerst unveraendert, dann die andere
// Schreibweise.
export function symbolVariants(symbol: string): string[] {
  const s = symbol.trim().toUpperCase();
  const out = [s];
  if (s.includes(".")) out.push(s.replace(/\./g, "-"));
  else if (s.includes("-")) out.push(s.replace(/-/g, "."));
  return out;
}

// Echtes Profil in der Antwort? (nicht-leeres Array mit Objekt, das ein
// Symbol traegt)
export function hasProfile(r: FmpResultLike): boolean {
  if (!r.ok || !Array.isArray(r.data)) return false;
  return r.data.some((p) => p && typeof p === "object" && String((p as { symbol?: unknown }).symbol ?? "").length > 0);
}

export type TickerCheckFailure = "plan" | "rate_limit" | "auth" | "outage" | "network" | "other" | "no_results";

export interface TickerCheckResult {
  valid: string[];
  // Schreibweise, mit der FMP den Ticker kennt, falls sie von der Eingabe
  // abweicht (nur fuer FMP-Aufrufe, die Anzeige bleibt die Eingabe).
  fmpSymbols: Record<string, string>;
  // Gesetzt = Pruefung nicht aussagekraeftig (Client uebernimmt ungeprueft).
  failure: TickerCheckFailure | null;
  failureStatus: number | null;
  calls: number;
}

const SYSTEMIC: FmpClass[] = ["plan", "rate_limit", "auth", "outage", "network"];

export async function checkTickers(
  tickers: string[],
  fetchProfile: ProfileFetch,
  opts: { concurrency?: number } = {},
): Promise<TickerCheckResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 10);
  const result: TickerCheckResult = { valid: [], fmpSymbols: {}, failure: null, failureStatus: null, calls: 0 };
  const found = new Set<string>();
  let aborted = false;

  const call = async (symbol: string): Promise<FmpResultLike> => {
    result.calls++;
    return await fetchProfile(symbol);
  };

  // Ein Ticker: Varianten der Reihe nach. Systemische Fehler (Plan, Limit,
  // Key, Stoerung, Netz) beenden die ganze Pruefung - dann sagt "leer" nichts.
  const checkOne = async (t: string) => {
    for (const variant of symbolVariants(t)) {
      if (aborted) return;
      const r = await call(variant);
      const cls = classifyFmpResult(r);
      if (SYSTEMIC.includes(cls)) {
        aborted = true;
        result.failure = cls as TickerCheckFailure;
        result.failureStatus = r.status ?? null;
        return;
      }
      if (cls === "other") {
        // Unklarer HTTP-Fehler: wie systemisch behandeln, nicht als "ungueltig".
        aborted = true;
        result.failure = "other";
        result.failureStatus = r.status ?? null;
        return;
      }
      if (hasProfile(r)) {
        found.add(t);
        if (variant !== t) result.fmpSymbols[t] = variant;
        return;
      }
    }
  };

  let next = 0;
  const worker = async () => {
    while (!aborted && next < tickers.length) {
      const t = tickers[next++];
      await checkOne(t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));

  if (result.failure) return result;

  // Sicherheitsnetz: Kein einziger Treffer bei HTTP 200. Ob die Ticker
  // wirklich ungueltig sind oder die Pruefung kaputt ist, klaert ein
  // bekannter Ticker.
  if (found.size === 0 && tickers.length > 0 && !tickers.includes(CANARY_SYMBOL)) {
    const r = await call(CANARY_SYMBOL);
    const cls = classifyFmpResult(r);
    if (!hasProfile(r)) {
      const systemic = SYSTEMIC.includes(cls) || cls === "other";
      result.failure = systemic ? (cls as TickerCheckFailure) : "no_results";
      result.failureStatus = r.status ?? null;
      return result;
    }
  }

  result.valid = tickers.filter((t) => found.has(t));
  return result;
}

// Nutzermeldung je Fehlerart (kommt im Client als "Ticker konnten nicht
// geprueft werden (<Meldung>) - Auswahl ungeprueft").
export function failureMessage(f: TickerCheckFailure, status: number | null): string {
  const s = status ? ` (HTTP ${status})` : "";
  switch (f) {
    case "plan":
      return `FMP-Plan deckt die Abfrage nicht ab${s}`;
    case "rate_limit":
      return `FMP-Rate-Limit erreicht${s}`;
    case "auth":
      return `FMP-API-Key ungültig${s}`;
    case "outage":
      return `FMP-Störung${s}`;
    case "network":
      return "FMP nicht erreichbar";
    case "no_results":
      return "FMP lieferte für keinen Ticker ein Ergebnis";
    default:
      return `FMP-Antwort unklar${s}`;
  }
}

// Fuer analyse: Schreibweise, mit der FMP das Profil kennt. Ticker ohne
// Punkt/Bindestrich kosten keinen Zusatzaufruf. Findet keine Variante ein
// Profil, bleibt es bei der Eingabe (die Profilpruefung in analyse meldet
// dann "unbekannt" bzw. den passenden Fehler).
export async function resolveFmpSymbol(ticker: string, fetchProfile: ProfileFetch): Promise<string> {
  const variants = symbolVariants(ticker);
  if (variants.length < 2) return ticker;
  for (const v of variants) {
    const r = await fetchProfile(v);
    if (hasProfile(r)) return v;
  }
  return ticker;
}
