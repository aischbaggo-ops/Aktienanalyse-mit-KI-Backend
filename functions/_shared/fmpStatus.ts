// Einordnung von FMP-Antworten (Form von fmpGet() in analyse/index.ts) und
// die daraus abgeleiteten Abbruchgruende eines Analyse-Laufs. Rein, ohne Netz.
//
// Hintergrund: Ein 429 von FMP erschien bisher als "Keine Profildaten ...
// Ticker existiert vermutlich nicht". Fuer den Batch-Betrieb muss klar
// sein, ob ein Ticker unbekannt ist, im Plan fehlt, das Limit erreicht ist
// oder FMP gestoert ist - nur beim Limit lohnt eine Wiederholung.

export interface FmpResultLike {
  ok: boolean;
  data?: unknown;
  status?: number | null;
  error?: string;
  authError?: boolean;
}

export type FmpClass = "ok" | "empty" | "not_found" | "plan" | "rate_limit" | "outage" | "auth" | "network" | "other";

// FMP meldet Plan- und Limitgrenzen teils mit HTTP 402/429, teils als Text
// im Body ("Premium Query Parameter", "Restricted Endpoint", "Limit Reach").
function bodyText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const o = data as Record<string, unknown>;
    return String(o["Error Message"] ?? o.message ?? o.error ?? "");
  }
  return "";
}

export function classifyFmpResult(r: FmpResultLike | null | undefined): FmpClass {
  if (!r) return "network";
  const status = r.status ?? null;
  const text = bodyText(r.data).toLowerCase();
  if (r.authError || status === 401 || status === 403) return "auth";
  if (status === 429 || text.includes("limit reach")) return "rate_limit";
  if (status === 402 || text.includes("premium") || text.includes("restricted") || text.includes("subscription")) {
    return "plan";
  }
  if (status === 404) return "not_found";
  if (status !== null && status >= 500) return "outage";
  if (!r.ok) return status === null ? "network" : "other";
  if (Array.isArray(r.data)) return r.data.length > 0 ? "ok" : "empty";
  return r.data && typeof r.data === "object" ? "ok" : "empty";
}

// Fehlercodes in stock_analyses.last_run_error_code. Das Frontend wertet sie
// im Batch aus (Wiederholung nur bei *_rate_limit).
export type RunErrorCode =
  | "fmp_not_found"
  | "fmp_plan"
  | "fmp_rate_limit"
  | "fmp_outage"
  | "fmp_auth"
  | "fmp_network"
  | "fmp_other"
  | "llm_rate_limit"
  | "llm_error"
  | "score_incomplete";

export const FMP_MESSAGES: Record<Exclude<FmpClass, "ok" | "empty">, { code: RunErrorCode; message: string }> = {
  not_found: { code: "fmp_not_found", message: "Ticker bei FMP unbekannt (kein Profil gefunden)." },
  plan: { code: "fmp_plan", message: "FMP-Plan: Daten für diesen Ticker sind im aktuellen Abo nicht freigegeben." },
  rate_limit: { code: "fmp_rate_limit", message: "FMP-Rate-Limit erreicht. Bitte später erneut versuchen." },
  outage: { code: "fmp_outage", message: "FMP-Störung (Serverfehler). Bitte später erneut versuchen." },
  auth: { code: "fmp_auth", message: "FMP-API-Key ungültig oder abgelaufen." },
  network: { code: "fmp_network", message: "FMP nicht erreichbar (Netzwerkfehler). Bitte später erneut versuchen." },
  other: { code: "fmp_other", message: "FMP-Anfrage fehlgeschlagen." },
};

// Bewusster Abbruch eines Laufs mit fertiger, nutzertauglicher Meldung und
// Code (statt einer rohen Exception, die erst klassifiziert werden muss).
export class AnalysisAbort extends Error {
  constructor(public code: RunErrorCode, message: string) {
    super(message);
    this.name = "AnalysisAbort";
  }
}

// Profil-Abfrage: null = Profil da. Leeres Profil (HTTP 200, []) und 404
// heissen "unbekannt", alle anderen Fehler werden benannt.
export function profileAbort(profile: FmpResultLike | null | undefined): AnalysisAbort | null {
  const c = classifyFmpResult(profile);
  if (c === "ok") return null;
  const m = FMP_MESSAGES[c === "empty" ? "not_found" : c];
  return new AnalysisAbort(m.code, m.message);
}

// Irgendein FMP-Aufruf (ausser News) am Rate-Limit: Lauf abbrechen statt mit
// Luecken weiterzurechnen. Eine Wiederholung spaeter liefert volle Daten.
export function rateLimitAbort(results: Record<string, FmpResultLike | null | undefined>): AnalysisAbort | null {
  const hit = Object.entries(results).some(([name, r]) => name !== "news" && classifyFmpResult(r) === "rate_limit");
  return hit ? new AnalysisAbort("fmp_rate_limit", FMP_MESSAGES.rate_limit.message) : null;
}

// Ursache fuer fehlende Teilscores, soweit an den FMP-Antworten erkennbar.
function causeFor(results: (FmpResultLike | null | undefined)[], what: string, tooShort: string): string {
  const classes = results.map(classifyFmpResult);
  if (classes.includes("plan")) return `FMP-Plan: keine ${what}`;
  if (classes.includes("rate_limit")) return "FMP-Rate-Limit";
  if (classes.includes("outage")) return "FMP-Störung";
  if (classes.includes("network")) return "FMP nicht erreichbar";
  if (classes.every((c) => c === "empty" || c === "not_found")) return `FMP liefert keine ${what}`;
  return tooShort;
}

export interface PreLlmInput {
  scores: { fundamental: number | null; krise: number | null; trend: number | null };
  fundamentalResults: (FmpResultLike | null | undefined)[];
  stockPriceResults: (FmpResultLike | null | undefined)[];
}

// Teil 1 Batch-Auftrag: Steht vor dem LLM-Aufruf fest, dass Fundamental,
// Krise oder Trend fehlt, gibt es ohnehin keinen Gesamtscore - dann den
// Claude-Aufruf sparen und den Lauf mit dieser Meldung beenden.
export function preLlmAbort(input: PreLlmInput): AnalysisAbort | null {
  const { scores } = input;
  const missing: string[] = [];
  const causes: string[] = [];
  if (scores.fundamental === null) {
    missing.push("Fundamental");
    causes.push(causeFor(input.fundamentalResults, "Kennzahlen", "zu wenige Kennzahlen"));
  }
  if (scores.krise === null || scores.trend === null) {
    if (scores.krise === null) missing.push("Krise");
    if (scores.trend === null) missing.push("Trend");
    causes.push(causeFor(input.stockPriceResults, "Kursdaten", "zu kurze Kurshistorie"));
  }
  if (!missing.length) return null;
  const cause = [...new Set(causes)].join("; ");
  return new AnalysisAbort(
    "score_incomplete",
    `Gesamtscore nicht berechenbar (fehlend: ${missing.join(", ")}). Ursache: ${cause}. KI-Analyse wurde nicht gestartet.`,
  );
}
