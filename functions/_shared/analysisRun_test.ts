// Aufruf (aus dem Repo-Root): deno test functions/_shared/analysisRun_test.ts
// Rein lokal, ohne Netz und ohne DB: die Patches werden auf eine Zeile im
// Speicher angewendet, so wie UPDATE ... SET sie auf stock_analyses anwendet.
import { completionPatch, failurePatch, hasValidAnalysis, isCacheFresh, startPatch } from "./analysisRun.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const NOW = "2026-10-07T10:00:00.000Z";
const DATA_FIELDS = [
  "score_total", "score_fundamental", "score_qualitaet", "score_krise", "score_trend", "score_stabilitaet",
  "criteria", "warnings", "fazit", "chart_data", "bewertung", "prognose", "company_name", "current_price",
  "error_message", "error_message_public",
] as const;

function validRow(): Record<string, unknown> {
  return {
    ticker: "AAPL",
    status: "done",
    score_total: 70,
    score_fundamental: 65,
    score_qualitaet: 80,
    score_krise: 60,
    score_trend: 75,
    score_stabilitaet: 72,
    criteria: [{ name: "Geschaeftsmodell verstanden", ampel: "gruen" }],
    warnings: ["alt"],
    fazit: "altes Fazit",
    chart_data: { data_flags: { methodik_version: 2 } },
    bewertung: { dcf: 1 },
    prognose: { x: 1 },
    company_name: "Apple Inc.",
    current_price: 200,
    error_message: null,
    error_message_public: null,
    updated_at: "2026-10-05T08:00:00.000Z",
    last_run_status: "done",
  };
}

function newResult(isComplete: boolean): Record<string, unknown> {
  return {
    status: isComplete ? "done" : "error",
    score_total: isComplete ? 74 : null,
    score_fundamental: 68,
    score_qualitaet: 81,
    score_krise: isComplete ? 62 : null,
    score_trend: 77,
    score_stabilitaet: 70,
    criteria: [{ name: "neu" }],
    warnings: ["neu"],
    fazit: "neues Fazit",
    chart_data: { neu: true },
    bewertung: { dcf: 2 },
    prognose: { x: 2 },
    company_name: "Apple Inc.",
    current_price: 210,
    error_message: isComplete ? null : "Gesamtscore nicht berechenbar (fehlend: Krise).",
    error_message_public: isComplete ? null : "Die Analyse konnte nicht vollständig berechnet werden. Bitte versuche es erneut.",
  };
}

// Simuliert einen ganzen Lauf: Start-Patch, dann End-Patch.
function run(row: Record<string, unknown> | null, end: (hadValid: boolean) => Record<string, unknown>) {
  const hadValid = hasValidAnalysis(row as never);
  const started = { ...(row ?? { ticker: "AAPL" }), ...startPatch(hadValid, NOW) };
  return { started, finished: { ...started, ...end(hadValid) } };
}

function assertDataUnchanged(before: Record<string, unknown>, after: Record<string, unknown>) {
  for (const f of DATA_FIELDS) {
    assert(JSON.stringify(before[f]) === JSON.stringify(after[f]), `${f} unveraendert`);
  }
  assert(after.status === "done", "status bleibt done");
}

Deno.test("gueltige Analyse: nur done mit Gesamtscore", () => {
  assert(hasValidAnalysis(validRow() as never), "done + Score");
  assert(!hasValidAnalysis({ status: "done", score_total: null }), "done ohne Score");
  assert(!hasValidAnalysis({ status: "error", score_total: 70 }), "error mit Score");
  assert(!hasValidAnalysis({ status: "running", score_total: 70 }), "alter running-Stand");
  assert(!hasValidAnalysis(null), "keine Zeile");
});

Deno.test("Start: mit gueltiger Analyse bleibt status done, ohne wird er running", () => {
  const withValid = startPatch(true, NOW);
  assert(!("status" in withValid), "status nicht im Patch");
  assert(withValid.last_run_status === "running" && withValid.last_run_at === NOW, "last_run_*");
  const without = startPatch(false, NOW);
  assert(without.status === "running" && without.last_run_status === "running", "running");
});

Deno.test("neuer Ticker, Lauf scheitert -> status error, keine Daten", () => {
  const { started, finished } = run(null, (v) => failurePatch(v, "FMP 429 Rohtext", "FMP-Limit erreicht."));
  assert(started.status === "running", "waehrend des Laufs running");
  assert(finished.status === "error", "status error");
  assert(finished.score_total === null && finished.criteria === null && finished.fazit === null, "keine Daten");
  assert(finished.error_message === "FMP 429 Rohtext", "interne Meldung wie bisher");
  assert(finished.last_run_status === "error" && finished.last_run_error_public === "FMP-Limit erreicht.", "last_run_*");
});

Deno.test("gueltige Analyse + Refresh scheitert -> Daten unveraendert, last_run_status error", () => {
  const before = validRow();
  const { started, finished } = run(before, (v) => failurePatch(v, "LLM Rohtext", "Claude nicht erreichbar."));
  assertDataUnchanged(before, started);
  assertDataUnchanged(before, finished);
  assert(finished.last_run_status === "error", "last_run_status error");
  assert(finished.last_run_error_public === "Claude nicht erreichbar.", "oeffentliche Meldung");
  assert(!("error_message" in failurePatch(true, "x", null)), "interne Meldung nicht in stock_analyses");
});

Deno.test("gueltige Analyse + Refresh erfolgreich -> neue Daten", () => {
  const before = validRow();
  const result = newResult(true);
  const { finished } = run(before, (v) => completionPatch(result, true, v));
  for (const f of DATA_FIELDS) {
    assert(JSON.stringify(finished[f]) === JSON.stringify(result[f]), `${f} neu`);
  }
  assert(finished.status === "done" && finished.last_run_status === "done", "done");
  assert(finished.last_run_error_public === null, "Fehlerfeld geleert");
});

Deno.test("gueltige Analyse + Refresh ohne Gesamtscore -> Daten unveraendert", () => {
  const before = validRow();
  const { finished } = run(before, (v) => completionPatch(newResult(false), false, v));
  assertDataUnchanged(before, finished);
  assert(finished.last_run_status === "error", "last_run_status error");
  assert(String(finished.last_run_error_public).startsWith("Die Analyse konnte nicht"), "oeffentliche Meldung");
});

Deno.test("ohne gueltige Analyse + Lauf ohne Gesamtscore -> wie bisher status error", () => {
  const { finished } = run(null, (v) => completionPatch(newResult(false), false, v));
  assert(finished.status === "error" && finished.score_total === null, "error ohne Gesamtscore");
  assert(finished.last_run_status === "error", "last_run_status error");
});

Deno.test("Cache: nur gueltige Analyse juenger als 7 Tage, gemessen an updated_at", () => {
  const now = Date.parse(NOW);
  const row = validRow(); // updated_at zwei Tage alt
  assert(isCacheFresh(row as never, 7, now), "2 Tage alt -> frisch");
  assert(!isCacheFresh({ ...row, updated_at: "2026-09-29T09:00:00.000Z" } as never, 7, now), "8 Tage alt");
  assert(!isCacheFresh({ ...row, score_total: null } as never, 7, now), "ohne Gesamtscore");
  assert(!isCacheFresh({ ...row, status: "error" } as never, 7, now), "status error");
  // Ein laufender oder gescheiterter Refresh aendert die Antwort nicht.
  assert(isCacheFresh({ ...row, last_run_status: "error", last_run_at: NOW } as never, 7, now), "last_run_* egal");
});
