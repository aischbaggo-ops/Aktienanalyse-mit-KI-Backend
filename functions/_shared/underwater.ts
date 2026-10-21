// Unterwasser-Phasen und Notbremse (Spec Legrand_Score_Algorithmus.md,
// Abschnitt 6). Eigenes Modul, damit trend3.ts sie nutzen kann, ohne
// scoring.ts zu importieren (Importkreis, siehe ampel.ts).

// ---------- UNTERWASSER-PHASEN / NOTBREMSE (Spec Legrand_Score_Algorithmus.md, Trend) ----------
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export interface UnderwaterPhase {
  start: Date;
  end: Date;
  years: number;
  // true: Phase dauert am letzten Kurstermin noch an.
  open: boolean;
}

// rows: aufsteigend nach Datum. Eine Phase beginnt mit dem ersten Schlusskurs
// unter dem bisherigen Hoch und endet mit dem ersten Schlusskurs auf oder
// ueber diesem Hoch.
export function underwaterPhases(rows: { date: string; close: number }[]): UnderwaterPhase[] {
  const phases: UnderwaterPhase[] = [];
  if (!rows.length) return phases;
  let peak = rows[0].close;
  let start: Date | null = null;
  for (const r of rows) {
    if (r.close >= peak) {
      peak = r.close;
      if (start) {
        const end = new Date(r.date);
        phases.push({ start, end, years: (+end - +start) / YEAR_MS, open: false });
        start = null;
      }
    } else if (!start) {
      start = new Date(r.date);
    }
  }
  if (start) {
    const end = new Date(rows[rows.length - 1].date);
    phases.push({ start, end, years: (+end - +start) / YEAR_MS, open: true });
  }
  return phases;
}

export const NOTBREMSE_MIN_YEARS = 7;
export const NOTBREMSE_WINDOW_YEARS = 15;

// Notbremse: eine Phase laenger als 7 Jahre, die in den letzten rund 15 Jahren
// vor asOf lag. "Lag in den letzten 15 Jahren" heisst hier: die Phase reicht
// in dieses Fenster hinein (Ende oder laufende Phase), nicht erst ihr Beginn -
// sonst bliebe ein seit 18 Jahren anhaltender Seitwaertssumpf ohne Notbremse.
// Eine Phase, die vor dem Fenster endete (reine Alt-Durststrecke), loest sie
// nicht aus.
export function notbremseTriggered(phases: UnderwaterPhase[], asOf: Date): boolean {
  const cutoff = new Date(+asOf - NOTBREMSE_WINDOW_YEARS * YEAR_MS);
  return phases.some((p) => p.years > NOTBREMSE_MIN_YEARS && p.end >= cutoff);
}
