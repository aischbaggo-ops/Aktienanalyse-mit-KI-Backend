// Datenlage eines Analyse-Laufs (chart_data.data_flags) und News-Status.
// Reine Funktionen ohne DB-/Netzzugriff. Beeinflusst weder Score noch
// Statusregel, Cache oder Parser - nur Kennzeichnung und Prompt-Text fuer den
// News-Block.

// Der Vergleichsindex fuer Krise/Trend (analyse/index.ts, fetchFmpData).
// encodeURIComponent("^GSPC") ergibt "%5EGSPC", also genau die bisherige URL.
export const BENCHMARK_SYMBOL = "^GSPC";

export type NewsStatus = "ok" | "blocked" | "error" | "empty";

// Herkunft der News eines Laufs (siehe news.ts). Neue Quellen hier ergaenzen.
export type NewsSource = "fmp";

// Form des Ergebnisses von fmpGet() (analyse/index.ts).
export interface FmpResultLike {
  ok?: boolean;
  data?: unknown;
  status?: number | null;
  error?: string;
  // Anfang des Bodys, nur bei Nicht-JSON-Antworten des News-Endpunkts erfasst.
  bodySnippet?: string | null;
}

// Hinweise, dass der Zugriff verweigert ist (Klartext-Antworten wie
// "Restricted" oder "Premium Query Parameter" statt JSON). Bewusst keine
// Planbezeichnung: entscheidend ist, was der Endpunkt antwortet.
const BLOCKED_TEXT = /restricted|premium|upgrade|subscription|forbidden|unauthori[sz]ed|not available/i;

// Reihenfolge ist wichtig: 429 und 5xx sind vorruebergehende Fehler ("error")
// und werden vor jeder Inhaltspruefung entschieden.
export function classifyNewsStatus(r: FmpResultLike | null | undefined): NewsStatus {
  if (!r) return "error";
  const status = r.status ?? null;
  if (status === 429 || (status !== null && status >= 500)) return "error";
  if (r.ok && Array.isArray(r.data)) return r.data.length > 0 ? "ok" : "empty";
  if (status === 401 || status === 402 || status === 403) return "blocked";
  // JSON-Fehlerbody (Objekt statt Array), z.B. {"Error Message": "..."}.
  if (r.data && typeof r.data === "object" && !Array.isArray(r.data)) return "blocked";
  if (r.bodySnippet && BLOCKED_TEXT.test(r.bodySnippet)) return "blocked";
  return "error";
}

// Der Key-Fehler ("FMP-API-Key ungueltig oder abgelaufen.") gilt nur fuer die
// uebrigen Endpunkte. Ein News-Endpunkt, der mit HTTP 401/403 antwortet (auch
// mit JSON-Body), bricht den Lauf nicht ab, sondern ergibt news_status
// "blocked" (classifyNewsStatus).
export function fmpAuthErrorExcludingNews(
  results: Record<string, { authError?: boolean } | null | undefined>,
): boolean {
  return Object.entries(results).some(([name, r]) => name !== "news" && r?.authError === true);
}

// Prompt-Block "AKTUELLE NEWS": zustandsabhaengig und ohne Planname.
export function buildNewsSummary(newsRaw: any[], status: NewsStatus | undefined): string {
  if (newsRaw.length > 0) {
    return newsRaw.slice(0, 10).map((n: any) => `- [${n.publishedDate || n.date || ""}] ${n.title || n.text || ""}`).join("\n");
  }
  if (status === "empty") return "Keine aktuellen News gefunden.";
  return "News für diesen Lauf nicht abrufbar.";
}

// Waehrung der Berichte: aus der Bilanz (reportedCurrency), ersatzweise aus
// der GuV; null, wenn keines von beiden vorliegt.
export function reportedCurrencyFrom(balanceRows: any[], incomeRows: any[]): string | null {
  for (const rows of [balanceRows, incomeRows]) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const c = rows[i]?.reportedCurrency;
      if (typeof c === "string" && c.trim() !== "") return c.trim();
    }
  }
  return null;
}

// Version der Bewertungsmethodik, mit der eine Zeile entstand. Zeilen ohne das
// Feld (vor diesem Deploy) gelten als Version 1 (siehe View analysis_ranking).
// Erhoehen, sobald eine Aenderung Scores aelterer Zeilen nicht mehr
// vergleichbar macht.
export const METHODIK_VERSION = 1;

export interface DataFlags {
  news_status: NewsStatus;
  news_source: NewsSource;
  news_count: number;
  price_points: number;
  estimates_count: number;
  reported_currency: string | null;
  benchmark_symbol: string;
  methodik_version: number;
  // true: Das Fangnetz fuer eingebettete Tool-Felder (rescueEmbeddedFields) hat
  // bei diesem Lauf Felder uebernommen oder einen Anzeigetext gekuerzt.
  llm_recovered: boolean;
}

// Form des Befunds aus rescueEmbeddedFields() (nur die hier gelesenen Felder,
// damit diese Datei ohne Import aus llm/ rein bleibt).
export interface EmbeddedRecoveryLike {
  adopted?: Record<string, unknown>;
  cleanText?: Record<string, unknown>;
}

// Ein Lauf kann zwei LLM-Aufrufe haben (Kontrolllauf): true, wenn bei einem
// davon das Fangnetz etwas veraendert hat.
export function llmRecoveredFrom(runs: ReadonlyArray<EmbeddedRecoveryLike | null | undefined>): boolean {
  return runs.some((r) => !!r && (Object.keys(r.adopted ?? {}).length > 0 || Object.keys(r.cleanText ?? {}).length > 0));
}

export function buildDataFlags(input: {
  newsStatus: NewsStatus;
  newsSource?: NewsSource;
  availability: { news: number; priceStock: number; estimates: number };
  balanceRows: any[];
  incomeRows: any[];
  benchmarkSymbol?: string;
  llmRecovered?: boolean;
}): DataFlags {
  return {
    news_status: input.newsStatus,
    news_source: input.newsSource ?? "fmp",
    news_count: input.availability.news,
    price_points: input.availability.priceStock,
    estimates_count: input.availability.estimates,
    reported_currency: reportedCurrencyFrom(input.balanceRows, input.incomeRows),
    benchmark_symbol: input.benchmarkSymbol ?? BENCHMARK_SYMBOL,
    methodik_version: METHODIK_VERSION,
    llm_recovered: input.llmRecovered ?? false,
  };
}
