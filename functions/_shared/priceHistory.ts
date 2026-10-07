// Tageskurse ab 2000 in zwei Zeitfenstern. FMP liefert pro Aufruf von
// /historical-price-eod/full hoechstens 5000 Zeilen (beobachtet: AAPL und
// ^GSPC enden beide nach 5000 Handelstagen im November 2006). Ohne Aufteilung
// fehlen die Jahre 2000-2006 und das Dotcom-Krisenfenster wird nie bewertet.

export const PRICE_HISTORY_FROM = "2000-01-01";
// Grenze zwischen den Fenstern; beide Fenster bleiben deutlich unter 5000
// Handelstagen (2000-2009: ca. 2500, 2010-heute: ca. 4200).
export const PRICE_WINDOW_SPLIT = "2010-01-01";

export function priceHistoryPaths(symbol: string): [string, string] {
  const s = encodeURIComponent(symbol);
  return [
    `/historical-price-eod/full?symbol=${s}&from=${PRICE_HISTORY_FROM}&to=2009-12-31`,
    `/historical-price-eod/full?symbol=${s}&from=${PRICE_WINDOW_SPLIT}`,
  ];
}

interface FmpResult {
  ok?: boolean;
  data?: unknown;
  authError?: boolean;
  status?: number | null;
  error?: string;
}

// Fuehrt die beiden Fenster zu EINEM Ergebnis in der Form von fmpGet()
// zusammen. ok, sobald ein Fenster Daten liefert (eine junge Aktie hat im
// alten Fenster schlicht nichts). Doppelte Tage werden entfernt.
export function mergePriceResults(older: FmpResult, newer: FmpResult): FmpResult {
  const rows = (r: FmpResult) => (r.ok && Array.isArray(r.data) ? (r.data as any[]) : []);
  const byDate = new Map<string, any>();
  for (const row of [...rows(older), ...rows(newer)]) {
    if (row && typeof row.date === "string") byDate.set(row.date, row);
  }
  const data = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const ok = older.ok === true || newer.ok === true;
  return {
    ok,
    data: ok ? data : (newer.data ?? older.data),
    authError: older.authError === true || newer.authError === true,
    status: newer.status ?? older.status ?? null,
    ...(ok ? {} : { error: newer.error ?? older.error }),
  };
}
