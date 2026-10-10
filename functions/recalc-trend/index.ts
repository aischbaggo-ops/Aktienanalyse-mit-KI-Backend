import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsFor } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { requireAdmin } from "../_shared/adminGate.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";
import { logApiCall } from "../_shared/apiCallLog.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { priceHistoryPaths, mergePriceResults } from "../_shared/priceHistory.ts";
import { BENCHMARK_SYMBOL } from "../_shared/dataFlags.ts";
import {
  computeTrend3, computeTotalWithTrend3, METHODIK_VERSION_TREND3,
  NICHT_BEWERTBAR_KURZE_HISTORIE, TREND3_CONFIG, type PriceRow,
} from "../_shared/trend3.ts";

// ---------------------------------------------------------------------------
// Rechnet die Dimension Trend auf Methodik 3 neu (Spec Abschnitt 6, Variante
// A2) - OHNE Claude, nur aus Tageskursen. Fazit, SWOT, Bewertung, Prognose und
// die Teilscores Fundamental, Qualitaet und Krise bleiben unberuehrt.
//
// dry_run ist Standard: ohne "dry_run": false wird NICHTS geschrieben.
// Geschrieben wird ueber die RPC apply_trend3 (Migration 20261010120000):
// sie sichert den Vorzustand, haelt updated_at fest und bricht ab, wenn die
// Zeile zwischenzeitlich von einem Analyse-Lauf geaendert wurde.
// ---------------------------------------------------------------------------

const FMP_BASE = "https://financialmodelingprep.com/stable";
const FUNCTION_NAME = "recalc-trend";
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const CONCURRENCY = 5;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface FmpResult {
  ok: boolean;
  data?: unknown;
  authError?: boolean;
  status?: number | null;
  error?: string;
}

async function fmpGet(path: string, fmpKey: string, ticker: string): Promise<FmpResult> {
  const startedAt = Date.now();
  let status: number | null = null;
  try {
    const url = FMP_BASE + path + (path.includes("?") ? "&" : "?") + "apikey=" + fmpKey;
    const res = await fetch(url);
    status = res.status;
    const data = await res.json();
    const authError = res.status === 401 || res.status === 403;
    await logApiCall({
      functionName: FUNCTION_NAME, provider: "fmp", callType: path.split("?")[0],
      ticker, durationMs: Date.now() - startedAt, success: res.ok && !authError,
      errorMessage: res.ok && !authError ? null : `FMP ${status}`,
    }).catch(() => {});
    if (!res.ok || authError) {
      return { ok: false, authError, status, error: `FMP ${status}` };
    }
    return { ok: true, data, status };
  } catch (e) {
    await logApiCall({
      functionName: FUNCTION_NAME, provider: "fmp", callType: path.split("?")[0],
      ticker, durationMs: Date.now() - startedAt, success: false,
      errorMessage: e instanceof Error ? e.message : String(e),
    }).catch(() => {});
    return { ok: false, status, error: e instanceof Error ? e.message : String(e) };
  }
}

function toRows(result: FmpResult): PriceRow[] {
  if (!result.ok || !Array.isArray(result.data)) return [];
  return (result.data as Record<string, unknown>[])
    .filter((r) => typeof r?.date === "string" && typeof r?.close === "number")
    .map((r) => ({ date: (r.date as string).slice(0, 10), close: r.close as number }));
}

async function fetchPrices(symbol: string, fmpKey: string, ticker: string) {
  const [oldPath, newPath] = priceHistoryPaths(symbol);
  const [older, newer] = await Promise.all([
    fmpGet(oldPath, fmpKey, ticker),
    fmpGet(newPath, fmpKey, ticker),
  ]);
  const merged = mergePriceResults(older, newer) as FmpResult;
  return { rows: toRows(merged), authError: merged.authError === true, ok: merged.ok };
}

// Monatsreihe fuer die Charts: letzter Schlusskurs je Kalendermonat.
// Gleiche Ableitung wie in scoring.ts, damit die Anzeige unveraendert bleibt.
function toMonthlySeries(rows: PriceRow[]) {
  const byMonth = new Map<string, PriceRow>();
  for (const r of rows) byMonth.set(r.date.slice(0, 7), { date: r.date, close: r.close });
  return [...byMonth.values()];
}

// Jahresrenditen auf KALENDERJAHREN fuer die Balken in der Analyseansicht.
// Entscheidung vom 10.10.2026: returnBars bleibt auf Kalenderjahren, die
// Kopplung an die Score-Kennzahl wird aufgegeben (Methodik 3 verankert die
// Jahresrenditen am Stichtag, das waere fuer die Anzeige unverstaendlich).
function calendarReturnBars(rows: PriceRow[]) {
  const byYear = new Map<string, number>();
  for (const r of rows) byYear.set(r.date.slice(0, 4), r.close);
  const years = [...byYear.keys()].sort();
  const bars: { period: string; pct: number }[] = [];
  for (let i = 1; i < years.length; i++) {
    const prev = byYear.get(years[i - 1])!, curr = byYear.get(years[i])!;
    if (prev) bars.push({ period: years[i], pct: Math.round((curr / prev - 1) * 1000) / 1000 });
  }
  return bars;
}

interface AnalysisRow {
  ticker: string;
  status: string;
  updated_at: string;
  score_fundamental: number | null;
  score_qualitaet: number | null;
  score_krise: number | null;
  score_trend: number | null;
  score_total: number | null;
  criteria: unknown;
  chart_data: Record<string, unknown> | null;
  error_message: string | null;
  error_message_public: string | null;
}

Deno.serve(async (req) => {
  const corsHeaders = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(req);
  if ("error" in auth) return json({ error: auth.error }, auth.status);
  const admin = await requireAdmin(auth.userId);
  if (!admin.ok) return json({ error: admin.error }, admin.status);

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    // Schreiben nur, wenn dry_run AUSDRUECKLICH false ist.
    const dryRun = body.dry_run !== false;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(body.offset) || 0);
    const wanted = Array.isArray(body.tickers)
      ? [...new Set((body.tickers as unknown[])
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean))]
      : null;
    if (!wanted && body.all !== true) {
      return json({ error: 'Entweder "tickers" angeben oder "all": true setzen.' }, 400);
    }

    const { fmpKey } = await loadUserApiKeys(auth.userId);
    if (!fmpKey) return json({ error: "Kein FMP-Schluessel hinterlegt." }, 400);

    // Laeuft gerade ein Analyse-Batch, wuerde er dieselben Zeilen schreiben.
    // Im Dry-Run ist das harmlos, beim Schreiben nicht.
    if (!dryRun) {
      const { count } = await supabase
        .from("stock_analyses")
        .select("ticker", { count: "exact", head: true })
        .eq("last_run_status", "running");
      if ((count ?? 0) > 0) {
        return json({
          error: `Es laufen gerade ${count} Analysen. Neuberechnung abgebrochen, ` +
            `damit keine Ergebnisse ueberschrieben werden.`,
        }, 409);
      }
    }

    let query = supabase
      .from("stock_analyses")
      .select("ticker, status, updated_at, score_fundamental, score_qualitaet, score_krise, " +
        "score_trend, score_total, criteria, chart_data, error_message, error_message_public")
      .eq("status", "done")
      .order("ticker");
    if (wanted) query = query.in("ticker", wanted);
    else query = query.range(offset, offset + limit - 1);
    const { data: rowsData, error: rowsError } = await query;
    if (rowsError) throw new Error(`Zeilen lesen fehlgeschlagen: ${rowsError.message}`);
    const rows = (rowsData ?? []) as unknown as AnalysisRow[];
    if (!rows.length) return json({ dry_run: dryRun, geprueft: 0, ergebnisse: [], hinweis: "Keine passenden Zeilen." });

    // Der Index ist fuer alle Ticker derselbe: einmal laden statt 514-mal.
    const indexPrices = await fetchPrices(BENCHMARK_SYMBOL, fmpKey, BENCHMARK_SYMBOL);
    if (indexPrices.authError) return json({ error: "FMP-Schluessel ungueltig oder abgelaufen." }, 502);
    if (indexPrices.rows.length < 2) {
      return json({ error: "Keine Indexkurse von FMP erhalten, Neuberechnung nicht moeglich." }, 502);
    }

    const results: Record<string, unknown>[] = [];
    let geschrieben = 0, uebersprungen = 0, ohneTrend = 0;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row) => {
        const stock = await fetchPrices(row.ticker, fmpKey, row.ticker);
        if (stock.authError) {
          results.push({ ticker: row.ticker, uebersprungen: "FMP-Schluessel ungueltig" });
          uebersprungen++;
          return;
        }
        if (stock.rows.length < 2) {
          results.push({ ticker: row.ticker, uebersprungen: "keine Kurse von FMP" });
          uebersprungen++;
          return;
        }

        const t3 = computeTrend3(stock.rows, indexPrices.rows);
        const totalNeu = computeTotalWithTrend3(
          row.score_fundamental, row.score_qualitaet, row.score_krise, t3.score,
        );
        const trendNeu = t3.score === null ? null : Math.round(t3.score * 10) / 10;
        if (t3.score === null) ohneTrend++;

        const eintrag: Record<string, unknown> = {
          ticker: row.ticker,
          trend_alt: row.score_trend, trend_neu: trendNeu,
          total_alt: row.score_total, total_neu: totalNeu,
          delta: totalNeu !== null && row.score_total !== null ? totalNeu - Number(row.score_total) : null,
          fenster: t3.nFenster, notbremse: t3.notbremse,
          ampeln: t3.kriterien.map((k) => ({ name: k.name, ampel: k.ampel })),
          kennzahlen: t3.kennzahlen,
          nicht_bewertbar: t3.nichtBewertbar,
          kurse: stock.rows.length,
        };

        if (dryRun) {
          results.push(eintrag);
          return;
        }

        // criteria: NUR die vier Trend-Eintraege ersetzen, alles andere
        // (Fundamental und die 20 Qualitaets-Kriterien von Claude) bleibt.
        const altKriterien = Array.isArray(row.criteria) ? row.criteria as Record<string, unknown>[] : [];
        const criteriaNeu = [
          ...altKriterien.filter((k) => k?.dimension !== "Trend"),
          ...t3.kriterien,
        ];

        const chartAlt = (row.chart_data ?? {}) as Record<string, unknown>;
        const flagsAlt = (chartAlt.data_flags ?? {}) as Record<string, unknown>;
        const chartNeu: Record<string, unknown> = {
          ...chartAlt,
          trend: {
            methodik: METHODIK_VERSION_TREND3,
            score: t3.score,
            kennzahlen: t3.kennzahlen,
            fenster: t3.fenster,
            notbremse: t3.notbremse,
            gemeinsamerStart: t3.gemeinsamerStart,
            asOf: t3.asOf,
            schwellen: TREND3_CONFIG,
          },
          data_flags: {
            ...flagsAlt,
            methodik_version: METHODIK_VERSION_TREND3,
            trend_recalc_at: new Date().toISOString(),
          },
          priceMonthly: {
            stock: toMonthlySeries(stock.rows),
            index: toMonthlySeries(indexPrices.rows),
          },
          returnBars: calendarReturnBars(stock.rows),
        };

        // Statusregel: ohne Gesamtscore ist die Zeile nicht bewertbar. Die
        // Teilscores F, Q und Krise bleiben in der Zeile stehen.
        const istBewertbar = totalNeu !== null;
        const statusNeu = istBewertbar ? "done" : "error";
        const errPublic = istBewertbar
          ? row.error_message_public
          : `Nicht bewertbar (${NICHT_BEWERTBAR_KURZE_HISTORIE}).`;
        const errInternal = istBewertbar
          ? row.error_message
          : `Trend nicht berechenbar: ${t3.nichtBewertbar ?? "kein gueltiges Zeitfenster"}.`;

        const { data: applied, error: applyError } = await supabase.rpc("apply_trend3", {
          p_ticker: row.ticker,
          p_expected_updated_at: row.updated_at,
          p_score_trend: t3.score,
          p_score_total: totalNeu,
          p_criteria: criteriaNeu,
          p_chart_data: chartNeu,
          p_status: statusNeu,
          p_error_message: errInternal,
          p_error_message_public: errPublic,
        });
        if (applyError) {
          results.push({ ...eintrag, geschrieben: false, fehler: applyError.message });
          uebersprungen++;
          return;
        }
        geschrieben++;
        results.push({ ...eintrag, geschrieben: true, status_neu: statusNeu, rpc: applied });
      }));
    }

    const mitBeiden = results.filter((r) => typeof r.delta === "number");
    const summary = {
      dry_run: dryRun,
      geprueft: rows.length,
      geschrieben,
      uebersprungen,
      ohne_trend: ohneTrend,
      differenz_ueber_5_punkte: mitBeiden.filter((r) => Math.abs(r.delta as number) > 5).length,
      mittlere_aenderung: mitBeiden.length
        ? Math.round(mitBeiden.reduce((s, r) => s + (r.delta as number), 0) / mitBeiden.length * 100) / 100
        : null,
      schwellen: TREND3_CONFIG,
      indexkurse: indexPrices.rows.length,
    };
    return json({ ...summary, ergebnisse: results.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logFunctionError(FUNCTION_NAME, auth.userId, message).catch(() => {});
    return json({ error: message }, 500);
  }
});
