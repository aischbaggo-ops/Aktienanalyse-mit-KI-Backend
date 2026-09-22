// Unterstuetzte Indizes fuer getIndexConstituents() (index-constituents
// Function). Muss inhaltlich mit frontend/src/constants/indices.ts
// uebereinstimmen (Label/Reihenfolge im Auswahlmenue) - die beiden Repos
// werden unabhaengig versioniert, daher hier bewusst dupliziert statt
// geteilt.
//
// FMP-Konstituenten-Endpoints (sp500-constituent/nasdaq-constituent/
// dowjones-constituent) liefern im Free-Plan HTTP 402 (live gegen einen
// echten Key getestet, 2026-09-22) - kein Fallback-Handling dafuer noetig,
// getIndexConstituents() geht fuer alle Indizes direkt und ausschliesslich
// gegen die manuell gepflegte Tabelle index_constituents (Seed-Daten aus
// Wikipedia, siehe scripts/seed-index-constituents).
export interface IndexDefinition {
  id: string;
  label: string;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { id: "dax", label: "DAX" },
  { id: "mdax", label: "MDAX" },
  { id: "sdax", label: "SDAX" },
  { id: "sp500", label: "S&P 500" },
  { id: "nasdaq100", label: "NASDAQ 100" },
  { id: "dowjones", label: "Dow Jones" },
];

export function findIndexDefinition(indexId: string): IndexDefinition | undefined {
  return INDEX_DEFINITIONS.find((d) => d.id === indexId);
}
