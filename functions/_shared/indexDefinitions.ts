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
// enabled: false = DAX/MDAX/SDAX sind zurueckgestellt (Scope-Reduzierung
// 2026-09-22): FMP deckt Deutschland/XETRA erst ab dem Ultimate-Plan
// ($149/Monat) ab, SAP.DE/DTE.DE etc. liefern im aktuellen Plan
// durchgehend HTTP 402 - das betrifft nicht nur die Index-Auswahl,
// sondern JEDE Einzelanalyse eines deutschen Tickers. Deutschland-Frage
// (Ultimate-Plan vs. Zweitanbieter) ist ein eigenstaendiges, separates
// Thema. Seed-Daten fuer DAX/MDAX bleiben in der Migration liegen, SDAX
// ist noch offen (Wikipedia liefert dafuer keine Ticker-Symbole, siehe
// Migration 20260922110000). NICHT ohne geklaerte Datenquelle wieder auf
// true setzen - findIndexDefinition() unten lehnt deaktivierte Indizes
// weiterhin serverseitig ab, auch falls das Frontend sie doch anzeigen
// sollte.
export interface IndexDefinition {
  id: string;
  label: string;
  enabled: boolean;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { id: "dax", label: "DAX", enabled: false },
  { id: "mdax", label: "MDAX", enabled: false },
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
