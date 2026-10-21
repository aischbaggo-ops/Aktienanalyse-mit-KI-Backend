// ---------------------------------------------------------------------------
// METHODIK 4: Region je Aktie - Heimatindex, Krisenfenster, Trend-Schwellen
// ---------------------------------------------------------------------------
// Bis Methodik 3 war alles auf die USA verdrahtet: ^GSPC als Benchmark, fuenf
// US-datierte Krisenfenster, eine CAGR-Schwelle. Methodik 4 macht daraus eine
// Konfiguration je Region, die aus dem Laenderkennzeichen des FMP-Profils
// abgeleitet wird.
//
// Entscheidungen Michael vom 20.10.2026:
//  * Heimatindex je LAND, nicht je Indexfamilie. Fuer Deutschland ^GDAXI,
//    auch fuer MDAX- und SDAX-Werte. Grund: ^SDAXI reicht nur bis 03/2013
//    zurueck (Testlauf claude/fmp_europa_test_20261020_212754.json), damit
//    haetten die Zeitfenster 2 und 3 keine Indexdaten und die A2-Regel wuerde
//    jeden SDAX-Wert auf 2013+ kuerzen.
//  * Sechstes Krisenfenster "Eurokrise" fuer Europa.
//  * CAGR-Schwelle 6 % statt 8 % fuer Europa.
//  * Rangliste getrennt nach Region, Prognose nur fuer die USA.
//
// Die US-Konfiguration bildet Methodik 3 unveraendert ab. Das ist Absicht und
// wird in region_test.ts festgehalten: eine US-Analyse muss nach dieser
// Umstellung dasselbe ergeben wie vorher.
// ---------------------------------------------------------------------------

import { TREND3_CONFIG, type Trend3Config } from "./trend3.ts";

export interface Crisis {
  name: string;
  from: string;
  to: string;
  // Recency-Gewicht aus der Spec (Abschnitt 5). Wird ueber die Summe aller
  // Fenster normalisiert, die Zahlen muessen sich also nicht zu 1 addieren.
  r: number;
}

export interface RegionConfig {
  id: string;
  name: string;
  benchmark: string;
  crises: Crisis[];
  trend: Trend3Config;
  // Die Prognose (Kursziele aus Multiples) ist auf US-Verhaeltnisse
  // zugeschnitten und bleibt fuer andere Regionen aus.
  prognose: boolean;
}

// Fuenf Fenster der Spec v1.2, Abschnitt 5. Unveraendert seit Methodik 2.
export const KRISEN_US: Crisis[] = [
  { name: "Dotcom", from: "2000-01-01", to: "2002-12-31", r: 0.3 },
  { name: "Finanzkrise", from: "2007-10-01", to: "2009-03-31", r: 0.55 },
  { name: "Corona", from: "2020-01-01", to: "2020-12-31", r: 1.0 },
  { name: "Zins/Inflation", from: "2022-01-01", to: "2022-12-31", r: 1.15 },
  { name: "Zoll", from: "2025-01-01", to: "2025-12-31", r: 1.3 },
];

// Europa: dieselben fuenf plus die Eurokrise. Deren akute Phase lief von der
// Herabstufung der US-Bonitaet und der Zuspitzung um Griechenland im Juli 2011
// bis zur Draghi-Zusage Ende Juli 2012 ("whatever it takes"); der DAX verlor
// in diesem Fenster rund ein Drittel, der S&P beendete 2011 praktisch flach -
// deshalb fehlt das Fenster in der US-Liste zu Recht und in der europaeischen
// nicht.
//
// Gewicht 0,7: die bestehenden Gewichte folgen der Nähe zur Gegenwart
// (2007-2009 = 0,55, 2020 = 1,0). Zeitlich liegt die Eurokrise bei knapp
// einem Drittel dieser Strecke, interpoliert also bei rund 0,68. 0,7 ist der
// gerundete Wert; von Michael noch nicht ausdruecklich bestaetigt.
export const KRISE_EUROKRISE: Crisis =
  { name: "Eurokrise", from: "2011-07-01", to: "2012-07-31", r: 0.7 };

export const KRISEN_EU: Crisis[] = [
  KRISEN_US[0],
  KRISEN_US[1],
  KRISE_EUROKRISE,
  KRISEN_US[2],
  KRISEN_US[3],
  KRISEN_US[4],
].sort((a, b) => (a.from < b.from ? -1 : 1));

export const REGION_US: RegionConfig = {
  id: "US",
  name: "USA",
  benchmark: "^GSPC",
  crises: KRISEN_US,
  trend: TREND3_CONFIG,
  prognose: true,
};

export const REGION_DE: RegionConfig = {
  id: "DE",
  name: "Deutschland",
  benchmark: "^GDAXI",
  crises: KRISEN_EU,
  // Nur die CAGR-Schwelle weicht ab: 8 % sind am S&P kalibriert, der DAX
  // liegt langfristig niedriger. Volatilitaet, Unterwasser und die Differenz
  // zum Index bleiben, weil sie relativ zum Heimatindex gemessen werden.
  trend: { ...TREND3_CONFIG, cagrGreen: 0.06 },
  prognose: false,
};

// Laenderkennzeichen aus dem FMP-Profil (profile.country, z. B. "US", "DE").
const NACH_LAND: Record<string, RegionConfig> = {
  US: REGION_US,
  DE: REGION_DE,
};

// Indexzugehoerigkeit aus index_constituents. Sie geht dem Land VOR: Airbus
// steht im DAX, notiert aber in Paris und ist niederlaendisch registriert
// (AIR.PA). Nach dem Land allein wuerde Airbus gegen den S&P mit
// US-Krisenfenstern gemessen - fuer ein DAX-Mitglied offensichtlich falsch.
// Ein Mitglied eines deutschen Index wird gegen den DAX gemessen, unabhaengig
// vom Handelsplatz.
const NACH_INDEX: Record<string, RegionConfig> = {
  dax: REGION_DE,
  mdax: REGION_DE,
  sdax: REGION_DE,
  sp500: REGION_US,
  nasdaq100: REGION_US,
  dowjones: REGION_US,
};

export function regionForIndex(indexId: string | null | undefined): RegionConfig | null {
  if (!indexId) return null;
  return NACH_INDEX[indexId.trim().toLowerCase()] ?? null;
}

export const REGION_STANDARD = REGION_US;

// Ein unbekanntes Land faellt bewusst auf die US-Konfiguration zurueck statt
// zu scheitern: bis Methodik 3 wurde ohnehin jede Aktie so gerechnet, und ein
// harter Fehler wuerde bestehende Analysen abbrechen lassen. Die tatsaechlich
// verwendete Region steht in data_flags, der Fall ist damit sichtbar.
export function regionForCountry(country: string | null | undefined): RegionConfig {
  if (!country) return REGION_STANDARD;
  return NACH_LAND[country.trim().toUpperCase()] ?? REGION_STANDARD;
}

export function regionById(id: string | null | undefined): RegionConfig {
  if (!id) return REGION_STANDARD;
  const treffer = Object.values(NACH_LAND).find((r) => r.id === id.trim().toUpperCase());
  return treffer ?? REGION_STANDARD;
}

export const ALLE_REGIONEN: RegionConfig[] = [REGION_US, REGION_DE];

// Woher die Region stammt. Steht in den data_flags, damit ein Rueckfall
// sichtbar ist und nicht stillschweigend als Tatsache durchgeht.
export type RegionQuelle = "index" | "land" | "rueckfall";

export interface RegionAufloesung {
  region: RegionConfig;
  quelle: RegionQuelle;
  land: string | null;
  indizes: string[];
}

// Reihenfolge: Indexzugehoerigkeit, dann Land, dann Rueckfall. Der Rueckfall
// bleibt die US-Konfiguration (ein harter Fehler wuerde bestehende Analysen
// abbrechen), ist aber ueber quelle = "rueckfall" erkennbar.
export function resolveRegion(
  indizes: string[] | null | undefined,
  land: string | null | undefined,
): RegionAufloesung {
  const ids = (indizes ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const id of ids) {
    const r = regionForIndex(id);
    if (r) return { region: r, quelle: "index", land: land ?? null, indizes: ids };
  }
  const nachLand = land ? NACH_LAND[land.trim().toUpperCase()] : undefined;
  if (nachLand) return { region: nachLand, quelle: "land", land: land ?? null, indizes: ids };
  return { region: REGION_STANDARD, quelle: "rueckfall", land: land ?? null, indizes: ids };
}
