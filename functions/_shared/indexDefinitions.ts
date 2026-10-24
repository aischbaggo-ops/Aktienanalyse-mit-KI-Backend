// Unterstuetzte Indizes fuer getIndexConstituents() (index-constituents
// Function). Muss inhaltlich mit frontend/src/constants/indices.ts
// uebereinstimmen (Label/Reihenfolge im Auswahlmenue, enabled-Flag) - die
// beiden Repos werden unabhaengig versioniert, daher hier bewusst
// dupliziert statt geteilt.
//
// FMP-Konstituenten-Endpoints (sp500-constituent/nasdaq-constituent/
// dowjones-constituent) liefern im Free-Plan HTTP 402 (live gegen einen
// echten Key getestet, 2026-09-22) - kein Fallback-Handling dafuer noetig,
// getIndexConstituents() geht fuer alle Indizes direkt und ausschliesslich
// gegen die manuell gepflegte Tabelle index_constituents (Seed-Daten aus
// Wikipedia).
//
// DAX und MDAX waren seit dem 22.09.2026 abgeschaltet, weil FMP
// Deutschland/XETRA erst ab dem Ultimate-Plan abdeckt und deutsche Ticker
// durchgehend HTTP 402 lieferten. Dieser Grund ist weggefallen: seit dem
// 20.10.2026 liegt der Ultimate-Schluessel vor, der Testlauf
// (claude/fmp_europa_test_20261020_212754.json) zeigt fuer deutsche Werte
// rund 6850 Tageskurse ab 2000 und Jahresabschluesse in EUR. Zusammen mit
// Methodik 4 (Heimatindex je Region, region.ts) und dem Kollisionsschutz
// in validate-tickers ist die Bedingung des alten Kommentars - "nicht ohne
// geklaerte Datenquelle" - erfuellt.
//
// SDAX bleibt abgeschaltet: fuer die 70 Titel fehlen die Ticker-Symbole,
// Wikipedia listet sie weder auf Deutsch noch auf Englisch (siehe
// Migration 20260922110000), die Tabelle hat dafuer also keine Zeilen.
// findIndexDefinition() lehnt deaktivierte Indizes serverseitig ab, auch
// falls das Frontend sie doch anzeigen sollte.
export interface IndexDefinition {
  id: string;
  label: string;
  enabled: boolean;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { id: "dax", label: "DAX", enabled: true },
  { id: "mdax", label: "MDAX", enabled: true },
  { id: "sdax", label: "SDAX", enabled: false },
  { id: "sp500", label: "S&P 500", enabled: true },
  { id: "nasdaq100", label: "NASDAQ 100", enabled: true },
  { id: "dowjones", label: "Dow Jones", enabled: true },
];

// Nur aktivierte Indizes - Aufrufer, die ALLE (auch deaktivierte) Ids
// brauchen, z.B. fuer eine Fehlermeldung, verwenden INDEX_DEFINITIONS
// direkt.
export function findIndexDefinition(indexId: string): IndexDefinition | undefined {
  return INDEX_DEFINITIONS.find((d) => d.id === indexId && d.enabled);
}
