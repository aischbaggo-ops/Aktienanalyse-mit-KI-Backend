// Unterstuetzte Indizes fuer getIndexConstituents() (index-constituents
// Function). Muss inhaltlich mit frontend/src/constants/indices.ts
// uebereinstimmen (Label/Reihenfolge im Auswahlmenue) - die beiden Repos
// werden unabhaengig versioniert, daher hier bewusst dupliziert statt
// geteilt.
//
// fmpPath === null bedeutet: FMP-Konstituenten-Endpoint fuer diesen Index
// noch NICHT gegen einen echten Key bestaetigt (Stand 2026-09-22, siehe
// Uebergabe-Notiz "Offene technische Pruefung vor Umsetzung"). Bis zur
// Bestaetigung liefert getIndexConstituents() fuer diesen Index
// ausschliesslich aus der Fallback-Tabelle index_constituents. Nach dem
// Test: hier den bestaetigten Pfad eintragen (z.B. "/sp500-constituent")
// UND mapFmpRow() unten anhand der echten Antwortfelder pruefen/anpassen.
export interface IndexDefinition {
  id: string;
  label: string;
  fmpPath: string | null;
}

export const INDEX_DEFINITIONS: readonly IndexDefinition[] = [
  { id: "dax", label: "DAX", fmpPath: null },
  { id: "mdax", label: "MDAX", fmpPath: null },
  { id: "sdax", label: "SDAX", fmpPath: null },
  { id: "sp500", label: "S&P 500", fmpPath: null },
  { id: "nasdaq100", label: "NASDAQ 100", fmpPath: null },
];

export function findIndexDefinition(indexId: string): IndexDefinition | undefined {
  return INDEX_DEFINITIONS.find((d) => d.id === indexId);
}
