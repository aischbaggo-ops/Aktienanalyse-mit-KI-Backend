// Schreibregeln fuer stock_analyses rund um einen Analyse-Lauf (Ticket f).
// Reine Funktionen ohne DB-Zugriff - analyse/index.ts schreibt die hier
// gebauten Patches, die Tests in analysisRun_test.ts pruefen sie ohne Netz.
//
// Grundsatz: Eine gueltige Analyse (status "done" mit Gesamtscore) wird nur
// durch einen erfolgreichen Lauf ersetzt. Ein fehlgeschlagener oder
// unvollstaendiger Lauf setzt dann nur die last_run_*-Felder; Teilergebnisse
// werden verworfen und nie mit der alten Analyse gemischt.

export type LastRunStatus = "running" | "done" | "error";

export interface AnalysisRowLike {
  status?: string | null;
  score_total?: number | null;
  updated_at?: string | null;
}

export function hasValidAnalysis(row: AnalysisRowLike | null | undefined): boolean {
  return !!row && row.status === "done" && row.score_total != null;
}

// Cache-Treffer: gueltige Analyse, juenger als maxAgeDays. Gemessen an
// updated_at = Datum der gespeicherten Analyse (der Trigger laesst es bei
// reinen last_run_*-Aenderungen stehen, siehe Migration 20261007100000).
export function isCacheFresh(row: AnalysisRowLike | null | undefined, maxAgeDays: number, nowMs: number): boolean {
  if (!hasValidAnalysis(row) || !row!.updated_at) return false;
  const ageMs = nowMs - new Date(row!.updated_at).getTime();
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

// Start eines Laufs. status wird nur ohne gueltige Analyse auf "running"
// gesetzt - sonst bleibt die alte Analyse waehrend des Laufs sichtbar.
export function startPatch(hadValidAnalysis: boolean, nowIso: string): Record<string, unknown> {
  return {
    ...(hadValidAnalysis ? {} : { status: "running" }),
    last_run_status: "running",
    last_run_at: nowIso,
  };
}

// Ende eines Laufs, der bis zur Score-Berechnung kam. result ist die
// komplette Zeile aus runAnalysis() (inkl. status "done"/"error").
export function completionPatch(
  result: Record<string, unknown>,
  isComplete: boolean,
  hadValidAnalysis: boolean,
): Record<string, unknown> {
  const errorPublic = (result.error_message_public as string | null | undefined) ?? null;
  if (isComplete) {
    return { ...result, status: "done", last_run_status: "done", last_run_error_public: null };
  }
  if (hadValidAnalysis) {
    return { last_run_status: "error", last_run_error_public: errorPublic };
  }
  // Wie bisher: unvollstaendiges Ergebnis mit status "error".
  return { ...result, status: "error", last_run_status: "error", last_run_error_public: errorPublic };
}

// Lauf mit Exception (FMP-, LLM-, Netzfehler ...).
export function failurePatch(
  hadValidAnalysis: boolean,
  errorInternal: string,
  errorPublic: string | null,
): Record<string, unknown> {
  if (hadValidAnalysis) {
    return { last_run_status: "error", last_run_error_public: errorPublic };
  }
  // Wie bisher: status "error" heisst immer "kein verwertbares Ergebnis",
  // deshalb Scores/Kriterien/Fazit mit zuruecksetzen (NVDA-Feedback, siehe
  // catch-Block in analyse/index.ts).
  return {
    status: "error",
    error_message: errorInternal,
    error_message_public: errorPublic,
    score_total: null,
    score_fundamental: null,
    score_qualitaet: null,
    score_krise: null,
    score_trend: null,
    score_stabilitaet: null,
    criteria: null,
    warnings: null,
    fazit: null,
    last_run_status: "error",
    last_run_error_public: errorPublic,
  };
}
