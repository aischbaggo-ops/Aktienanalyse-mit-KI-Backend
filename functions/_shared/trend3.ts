// ---------------------------------------------------------------------------
// METHODIK 3: Dimension Trend nach Legrand_Score_Algorithmus.md v1.2 Abschnitt 6
// ---------------------------------------------------------------------------
// Unterschied zu Methodik 2 (scoring.ts): Dort wird jede Kennzahl EINMAL ueber
// die gesamte Historie gebildet und dabei jedes Kalenderjahr einzeln gewichtet
// (recencyFactor). Die Spec verlangt stattdessen, jede Kennzahl in DREI
// Zeitfenstern zu berechnen und die Fenster mit 2 / 1 / 0,5 zu mitteln; erst
// danach wird die Ampel gesetzt. Ausserdem:
//   - echter geometrischer CAGR statt eines Mittelwerts der Jahresrenditen,
//   - Aktie und Index im SELBEN Fenster verglichen (in Methodik 2 lief der
//     Index ueber seine ganze Historie ab 2000, auch bei einer Aktie von 2018 -
//     das beguenstigte junge Aktien um rund 12 Prozentpunkte Scheinrendite).
//
// Bewusste Abweichung von der Spec (Variante A2, von Michael am 10.10.2026
// entschieden, begruendet in claude/Trend_Schwellen_v1.md): Das
// Unterwasser-Verhaeltnis wird NICHT je Fenster gerechnet, sondern einmal ueber
// die ganze Historie - fuer Aktie und Index ueber den GEMEINSAMEN Zeitraum, der
// Index also erst ab dem ersten Kurs der Aktie. Je Fenster wird der Nenner
// (laengste Index-Phase im Fenster) klein und zufaellig; die Spec-Grenzen
// 0,8 / 1,2 sind an einem Langfrist-Beispiel kalibriert (Spec Zeile 188).
//
// Die Schwellen stehen in claude/Trend_Schwellen_v1.md und sind bewusst
// Konfiguration, nicht im Code verstreut.
// ---------------------------------------------------------------------------

import { underwaterPhases, notbremseTriggered, ampelLabel } from "./scoring.ts";

export interface PriceRow {
  date: string;   // "YYYY-MM-DD", aufsteigend sortiert erwartet
  close: number;
}

export interface Trend3Config {
  cagrGreen: number;          // CAGR > x -> gruen, >= 0 -> gelb
  volaGreen: number;          // Vola < x -> gruen
  volaYellow: number;         // Vola <= x -> gelb
  diffEdge: number;           // Differenz > +x gruen, >= -x gelb
  uwGreen: number;            // Unterwasser-Verhaeltnis < x -> gruen
  uwYellow: number;           // <= x -> gelb
  windowYears: number;        // Fensterlaenge (exakt 10 Jahre)
  weights: [number, number, number];
  minMonthsPerWindow: number; // ab so vielen Kalendermonaten gilt ein Fenster als vorhanden
}

export const TREND3_CONFIG: Trend3Config = {
  cagrGreen: 0.08,
  volaGreen: 0.25,
  volaYellow: 0.35,
  diffEdge: 0.01,
  uwGreen: 0.8,
  uwYellow: 1.2,
  windowYears: 10,
  weights: [2, 1, 0.5],
  minMonthsPerWindow: 36,
};

export const METHODIK_VERSION_TREND3 = 3;

// Namen der vier Kriterien. Unveraendert gegenueber Methodik 2, damit die
// Anzeige und ein Vergleich alt/neu ueber den Namen funktionieren.
export const TREND3_CRITERIA_NAMES = {
  cagr: "Aufwaertstrend ueber ca. 20 Jahre (zeitgewichtete CAGR)",
  vola: "Kontinuitaet (Volatilitaet der Jahresrenditen, zeitgewichtet)",
  uw: "Laengste Unterwasser-Phase relativ zum S&P",
  diff: "Performance vs. S&P (zeitgewichtete CAGR-Differenz)",
} as const;

const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------- Datums-Hilfen

// Monate von einem ISO-Datum abziehen. Ueberlauf wird auf den letzten Tag des
// Zielmonats geklemmt (31.03. minus 1 Monat -> 28./29.02.), damit kein Datum
// in den Folgemonat rutscht.
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

function yearsBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / (365.25 * DAY_MS);
}

export function sortRows(rows: PriceRow[]): PriceRow[] {
  return rows
    .filter((r) => r && typeof r.close === "number" && r.close > 0 && typeof r.date === "string")
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Letzter Kurs mit Datum <= iso. toleranceDays begrenzt, wie alt der Treffer
// sein darf - sonst wuerde bei einer Luecke (oder vor dem ersten Kurs) ein
// voellig anderer Zeitpunkt verwendet.
function closeAtOrBefore(rows: PriceRow[], iso: string, toleranceDays?: number): PriceRow | null {
  let lo = 0, hi = rows.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= iso) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (found < 0) return null;
  const row = rows[found];
  if (toleranceDays !== undefined && (Date.parse(iso) - Date.parse(row.date)) / DAY_MS > toleranceDays) {
    return null;
  }
  return row;
}

// ---------------------------------------------------------------- Kennzahlen

// Geometrischer CAGR im Fenster (fromIso, toIso]. Beginnt die Reihe erst
// innerhalb des Fensters, wird ab dem ersten vorhandenen Kurs gerechnet und die
// tatsaechlich verstrichene Zeit verwendet.
export function cagrInWindow(
  rows: PriceRow[], fromIso: string, toIso: string, minYears = 1,
): number | null {
  const end = closeAtOrBefore(rows, toIso);
  if (!end || end.date <= fromIso) return null;
  let base = closeAtOrBefore(rows, fromIso);
  if (!base) {
    const inside = rows.find((r) => r.date > fromIso && r.date <= toIso);
    if (!inside) return null;
    base = inside;
  }
  const years = yearsBetween(base.date, end.date);
  if (years < minYears) return null;
  return Math.pow(end.close / base.close, 1 / years) - 1;
}

// 12-Monats-Renditen, verankert am Stichtag und in Jahresschritten zurueck.
// Gezaehlt werden die Renditen, deren Endzeitpunkt im Fenster liegt. Die
// Verankerung am Stichtag (statt an Kalenderjahren wie in Methodik 2) passt zu
// Fenstergrenzen, die auf den Stichtag fallen.
export function annualReturns(
  rows: PriceRow[], asOfIso: string, fromIso: string, toIso: string,
): number[] {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const hiIso = addMonths(asOfIso, -12 * k);
    if (hiIso <= fromIso) break;
    if (hiIso > toIso) continue;
    const loIso = addMonths(hiIso, -12);
    const hi = closeAtOrBefore(rows, hiIso, 45);
    const lo = closeAtOrBefore(rows, loIso, 45);
    if (!hi || !lo) continue;
    out.push(hi.close / lo.close - 1);
  }
  return out;
}

export function populationStdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// Laengste Unterwasser-Phase (in Jahren) im Zeitraum (fromIso, toIso].
// Das Hoch startet beim ersten Kurs des Zeitraums, eine am Ende noch offene
// Phase zaehlt bis zum letzten Kurs.
export function longestUnderwaterYears(
  rows: PriceRow[], fromIso: string, toIso: string,
): number | null {
  const inside = rows.filter((r) => r.date > fromIso && r.date <= toIso);
  if (inside.length < 2) return null;
  return underwaterPhases(inside).reduce((max, p) => Math.max(max, p.years), 0);
}

function monthsCovered(rows: PriceRow[], fromIso: string, toIso: string): number {
  const months = new Set<string>();
  for (const r of rows) {
    if (r.date > fromIso && r.date <= toIso) months.add(r.date.slice(0, 7));
  }
  return months.size;
}

function weightedMean(pairs: { value: number | null; weight: number }[]): number | null {
  let num = 0, den = 0;
  for (const { value, weight } of pairs) {
    if (value === null) continue;
    num += value * weight;
    den += weight;
  }
  return den > 0 ? num / den : null;
}

// ---------------------------------------------------------------- Ergebnis

export interface Trend3Window {
  von: string;
  bis: string;
  faktor: number;
  monate: number;
  cagrStock: number | null;
  cagrIndex: number | null;
  vola: number | null;
  jahresrenditen: number;
}

export interface Trend3Criterion {
  dimension: "Trend";
  name: string;
  ampel: string;
  begruendung: string;
}

export interface Trend3Result {
  score: number | null;
  kriterien: Trend3Criterion[];
  ampeln: { cagr: number | null; vola: number | null; uw: number | null; diff: number | null };
  kennzahlen: {
    cagr: number | null;
    vola: number | null;
    uwRatio: number | null;
    diff: number | null;
    uwStockYears: number | null;
    uwIndexYears: number | null;
  };
  fenster: Trend3Window[];
  nFenster: number;
  notbremse: boolean;
  gemeinsamerStart: string | null;
  asOf: string | null;
  methodikVersion: number;
  // Grund, warum kein Score gebildet werden konnte (sonst null).
  nichtBewertbar: string | null;
}

const EMPTY = (reason: string): Trend3Result => ({
  score: null, kriterien: [], nFenster: 0, notbremse: false,
  ampeln: { cagr: null, vola: null, uw: null, diff: null },
  kennzahlen: { cagr: null, vola: null, uwRatio: null, diff: null, uwStockYears: null, uwIndexYears: null },
  fenster: [], gemeinsamerStart: null, asOf: null,
  methodikVersion: METHODIK_VERSION_TREND3, nichtBewertbar: reason,
});

export const NICHT_BEWERTBAR_KURZE_HISTORIE = "Kurshistorie unter 3 Jahren";

// ---------------------------------------------------------------------------
// Gemeinsame Behandlung "kein gueltiges Zeitfenster" fuer recalc-trend UND
// analyse. Beide muessen dieselben Spalten gleich setzen, sonst zeigt die
// Tabelle fuer dieselbe Ursache einmal "nicht bewertbar" und einmal "Fehler".
//
// Die Tabelle liest den Text NICHT aus error_message_public, sondern ueber
// attachErrorInfo() aus last_run_error_code und last_run_error_public
// (frontend/src/lib/analysisData.ts). assessmentText() zeigt nur dann
// "nicht bewertbar", wenn der Code 'score_incomplete' ist, und setzt den
// Klammertext, wenn die Meldung "zu kurze Kurshistorie" enthaelt. Beides
// muss also genau so drinstehen.
// ---------------------------------------------------------------------------

export const SCORE_INCOMPLETE_CODE = "score_incomplete";

export const NICHT_BEWERTBAR_PUBLIC =
  "Gesamtscore nicht berechenbar (fehlend: Trend). Ursache: zu kurze Kurshistorie " +
  `(weniger als ${TREND3_CONFIG.minMonthsPerWindow} Monatskurse in jedem Zeitfenster).`;

export function nichtBewertbarFelder(grund: string | null) {
  return {
    status: "error",
    last_run_status: "error",
    last_run_error_code: SCORE_INCOMPLETE_CODE,
    last_run_error_public: NICHT_BEWERTBAR_PUBLIC,
    error_message_public: NICHT_BEWERTBAR_PUBLIC,
    error_message: `Trend nach Methodik ${METHODIK_VERSION_TREND3} nicht berechenbar: ` +
      `${grund ?? "kein gueltiges Zeitfenster"}.`,
  };
}

export function computeTrend3(
  stockRaw: PriceRow[], indexRaw: PriceRow[], cfg: Trend3Config = TREND3_CONFIG,
): Trend3Result {
  const stock = sortRows(stockRaw);
  const index = sortRows(indexRaw);
  if (stock.length < 2 || index.length < 2) return EMPTY("Keine ausreichende Kurshistorie");

  // Stichtag: der letzte Tag, an dem BEIDE Reihen Kurse haben. Sonst wuerde ein
  // Fenster fuer die eine Reihe weiter reichen als fuer die andere.
  const asOf = stock[stock.length - 1].date < index[index.length - 1].date
    ? stock[stock.length - 1].date
    : index[index.length - 1].date;
  const gemeinsamerStart = stock[0].date > index[0].date ? stock[0].date : index[0].date;

  const wy = cfg.windowYears * 12;
  const bounds: [string, string][] = [
    [addMonths(asOf, -wy), asOf],
    [addMonths(asOf, -2 * wy), addMonths(asOf, -wy)],
    [addMonths(gemeinsamerStart, -1), addMonths(asOf, -2 * wy)],
  ];

  const fenster: Trend3Window[] = [];
  const cagrPairs: { value: number | null; weight: number }[] = [];
  const diffPairs: { value: number | null; weight: number }[] = [];
  const volaPairs: { value: number | null; weight: number }[] = [];

  bounds.forEach(([von, bis], i) => {
    if (bis <= von) return;
    const monate = monthsCovered(stock, von, bis);
    if (monate < cfg.minMonthsPerWindow) return;   // Fenster faellt ersatzlos weg
    const weight = cfg.weights[i];
    const cagrStock = cagrInWindow(stock, von, bis);
    const cagrIndex = cagrInWindow(index, von, bis);
    const rets = annualReturns(stock, asOf, von, bis);
    const vola = populationStdDev(rets);
    cagrPairs.push({ value: cagrStock, weight });
    diffPairs.push({
      value: cagrStock !== null && cagrIndex !== null ? cagrStock - cagrIndex : null,
      weight,
    });
    volaPairs.push({ value: vola, weight });
    fenster.push({ von, bis, faktor: weight, monate, cagrStock, cagrIndex, vola, jahresrenditen: rets.length });
  });

  // Entscheidung vom 10.10.2026: ohne ein einziges gueltiges Fenster gibt es
  // keinen Trend-Score - auch dann nicht, wenn das Unterwasser-Verhaeltnis
  // (das nicht an den Fenstern haengt) rechnerisch vorliegt.
  if (fenster.length === 0) return { ...EMPTY(NICHT_BEWERTBAR_KURZE_HISTORIE), asOf, gemeinsamerStart };

  const cagr = weightedMean(cagrPairs);
  const diff = weightedMean(diffPairs);
  const vola = weightedMean(volaPairs);

  // Variante A2: Unterwasser ueber die ganze Historie, gemeinsamer Zeitraum.
  const uwStockYears = longestUnderwaterYears(stock, addMonths(gemeinsamerStart, -1), asOf);
  const uwIndexYears = longestUnderwaterYears(index, addMonths(gemeinsamerStart, -1), asOf);
  // Hatte der Index im gemeinsamen Zeitraum ueberhaupt keine Unterwasser-Phase
  // (moeglich bei kurzem gemeinsamem Zeitraum), gibt es kein Verhaeltnis. Das
  // Kriterium darf dann aber nicht grau werden und ausfallen: Eine Aktie mit
  // eigener Durststrecke gegen einen Index ohne jede ist eindeutig schlechter
  // (rot), beide ohne Phase sind eindeutig gleich gut (gruen).
  let uwRatio: number | null = null;
  let uwDegenerate: 0 | 1 | null = null;
  if (uwStockYears !== null && uwIndexYears !== null) {
    if (uwIndexYears > 0) {
      uwRatio = uwStockYears / uwIndexYears;
    } else {
      uwDegenerate = uwStockYears > 0 ? 0 : 1;
    }
  }

  const notbremse = notbremseTriggered(underwaterPhases(stock), new Date(asOf));

  const aCagr = cagr === null ? null : cagr > cfg.cagrGreen ? 1 : cagr >= 0 ? 0.5 : 0;
  const aVola = vola === null ? null : vola < cfg.volaGreen ? 1 : vola <= cfg.volaYellow ? 0.5 : 0;
  let aUw = uwRatio !== null
    ? (uwRatio < cfg.uwGreen ? 1 : uwRatio <= cfg.uwYellow ? 0.5 : 0)
    : uwDegenerate;
  if (notbremse) aUw = 0;
  const aDiff = diff === null ? null : diff > cfg.diffEdge ? 1 : diff >= -cfg.diffEdge ? 0.5 : 0;

  const ampeln = { cagr: aCagr, vola: aVola, uw: aUw, diff: aDiff };
  const vals = Object.values(ampeln).filter((v): v is number => v !== null);
  const score = vals.length
    ? Math.min(100, (vals.reduce((a, b) => a + b, 0) / vals.length) * 100)
    : null;

  const pct = (v: number | null) => v === null ? "n/a" : `${(v * 100).toFixed(2)} %`;
  const num = (v: number | null, d = 3) => v === null ? "n/a" : v.toFixed(d);
  const fensterText = `${fenster.length} Fenster (${fenster.map((f) => `${f.von.slice(0, 7)} bis ${f.bis.slice(0, 7)}, Faktor ${f.faktor}`).join("; ")})`;

  const kriterien: Trend3Criterion[] = [
    {
      dimension: "Trend", name: TREND3_CRITERIA_NAMES.cagr, ampel: ampelLabel(aCagr),
      begruendung: aCagr === null
        ? "Kennzahl nicht berechenbar (fehlende Kurshistorie)."
        : `Zeitgewichteter CAGR ${pct(cagr)} pro Jahr, gruen ab ${pct(cfg.cagrGreen)}. ${fensterText}.`,
    },
    {
      dimension: "Trend", name: TREND3_CRITERIA_NAMES.vola, ampel: ampelLabel(aVola),
      begruendung: aVola === null
        ? "Kennzahl nicht berechenbar (zu wenige Jahresrenditen)."
        : `Zeitgewichtete Volatilitaet der Jahresrenditen ${num(vola)}, gruen unter ${num(cfg.volaGreen, 2)}, gelb bis ${num(cfg.volaYellow, 2)}.`,
    },
    {
      dimension: "Trend", name: TREND3_CRITERIA_NAMES.uw, ampel: ampelLabel(aUw),
      begruendung: notbremse
        ? `Notbremse: Unterwasser-Phase laenger als 7 Jahre innerhalb der letzten 15 Jahre (Aktie ${num(uwStockYears, 1)} Jahre, S&P ${num(uwIndexYears, 1)} Jahre im gemeinsamen Zeitraum ab ${gemeinsamerStart.slice(0, 7)}).`
        : aUw === null
        ? "Kennzahl nicht berechenbar (keine Kurshistorie im gemeinsamen Zeitraum)."
        : uwRatio === null
        ? `Der S&P hatte im gemeinsamen Zeitraum ab ${gemeinsamerStart.slice(0, 7)} keine Unterwasser-Phase; die Aktie ${num(uwStockYears, 1)} Jahre. Kein Verhaeltnis bildbar, daher ${aUw === 1 ? "gruen (beide ohne Phase)" : "rot (nur die Aktie unter Wasser)"}.`
        : `Laengste Unterwasser-Phase Aktie ${num(uwStockYears, 1)} Jahre, S&P ${num(uwIndexYears, 1)} Jahre, Verhaeltnis ${num(uwRatio, 2)} (gemeinsamer Zeitraum ab ${gemeinsamerStart.slice(0, 7)}).`,
    },
    {
      dimension: "Trend", name: TREND3_CRITERIA_NAMES.diff, ampel: ampelLabel(aDiff),
      begruendung: aDiff === null
        ? "Kennzahl nicht berechenbar (fehlende Kurshistorie)."
        : `Zeitgewichtete CAGR-Differenz zum S&P ${diff !== null && diff >= 0 ? "+" : ""}${pct(diff)} pro Jahr, je Fenster ueber denselben Zeitraum gerechnet.`,
    },
  ];

  return {
    score, kriterien, ampeln,
    kennzahlen: { cagr, vola, uwRatio, diff, uwStockYears, uwIndexYears },
    fenster, nFenster: fenster.length, notbremse,
    gemeinsamerStart, asOf,
    methodikVersion: METHODIK_VERSION_TREND3,
    nichtBewertbar: null,
  };
}

// Gesamtscore nach Spec Abschnitt 1. Fehlt ein Teilscore, gibt es keinen
// Gesamtscore (Statusregel: dann status = error, Anzeige "nicht bewertbar").
export function computeTotalWithTrend3(
  f: number | null, q: number | null, k: number | null, t: number | null,
): number | null {
  if (f === null || q === null || k === null || t === null) return null;
  return Math.round(0.35 * f + 0.25 * q + 0.20 * k + 0.20 * t);
}
