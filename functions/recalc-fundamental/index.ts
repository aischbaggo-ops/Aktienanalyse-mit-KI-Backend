import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsFor } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { requireAdmin } from "../_shared/adminGate.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";
import { logApiCall } from "../_shared/apiCallLog.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { resolveFmpSymbol } from "../_shared/tickerCheck.ts";
import {
  aendertSich, gesamtNeu, kriterienErsetzen, ohneDividendenfelder, rechneFundamental,
} from "../_shared/fundamentalRecalc.ts";

// ---------------------------------------------------------------------------
// Rechnet die Dimension Fundamental neu - OHNE Claude, nur aus GuV, Bilanz,
// Cashflow und Schaetzungen. Anlass: das Dividendenfeld wurde unter dem Namen
// der alten FMP-API gelesen, die drei Dividendenkriterien liefen bei keiner
// der 594 Analysen bis zum 24.10.2026 (siehe _shared/scoring.ts,
// dividendeAusCashflow).
//
// Qualitaet, Krise, Trend, Fazit, SWOT, Bewertung und Prognose bleiben
// unberuehrt; der Gesamtscore wird aus dem neuen Fundamentalscore und den
// gespeicherten uebrigen Teilscores neu gebildet.
//
// dry_run ist Standard: ohne "dry_run": false wird NICHTS geschrieben.
// Geschrieben wird ueber die RPC apply_fundamental (Migration
// 20261025100000): sie sichert den Vorzustand, haelt updated_at fest und
// bricht ab, wenn die Zeile zwischenzeitlich von einem Analyse-Lauf
// geaendert wurde. Zeilen, an denen sich nichts aendert, werden gar nicht
// angefasst.
// ---------------------------------------------------------------------------

const FMP_BASE = "https://financialmodelingprep.com/stable";
const FUNCTION_NAME = "recalc-fundamental";
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const CONCURRENCY = 5;
const DIVIDENDEN_KRITERIEN = ["Dividende stetig, keine Ausfaelle", "Dividende <= Gewinn", "Dividende <= Free Cashflow"];
const KO_VERSCHULDUNG_PRAEFIX = "Dynamischer Verschuldungsgrad zweistellig";

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
  warnings: unknown;
  chart_data: Record<string, unknown> | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const eineStelle = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

function letztesJahr(chart: Record<string, unknown> | null): string | null {
  const jahre = (chart?.fundamentalSeries as { years?: unknown } | undefined)?.years;
  return Array.isArray(jahre) && jahre.length ? String(jahre[jahre.length - 1]) : null;
}

function hatKoVerschuldung(warnings: unknown): boolean {
  return Array.isArray(warnings) &&
    warnings.some((w) => typeof w === "string" && w.startsWith(KO_VERSCHULDUNG_PRAEFIX));
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
    const schluessel: string = fmpKey;

    // Laeuft gerade ein Analyse-Batch, wuerde er dieselben Zeilen schreiben.
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

    // Ohne Status-Filter lesen, damit Zeilen mit status <> 'done' sichtbar
    // als "uebersprungen" auftauchen statt stillschweigend zu fehlen. Die
    // Reihenfolge nach ticker haelt die Offsets ueber den Lauf stabil.
    let query = supabase
      .from("stock_analyses")
      .select("ticker, status, updated_at, score_fundamental, score_qualitaet, score_krise, " +
        "score_trend, score_total, criteria, warnings, chart_data")
      .order("ticker");
    if (wanted) query = query.in("ticker", wanted);
    else query = query.range(offset, offset + limit - 1);
    const { data: rowsData, error: rowsError } = await query;
    if (rowsError) throw new Error(`Zeilen lesen fehlgeschlagen: ${rowsError.message}`);
    const alleRows = (rowsData ?? []) as unknown as AnalysisRow[];

    const results: Record<string, unknown>[] = [];
    let geschrieben = 0, unveraendert = 0, uebersprungen = 0;

    const rows: AnalysisRow[] = [];
    for (const row of alleRows) {
      if (row.status !== "done") {
        results.push({ ticker: row.ticker, uebersprungen: `status ist '${row.status}', nicht 'done'` });
        uebersprungen++;
        continue;
      }
      rows.push(row);
    }
    if (wanted) {
      for (const t of wanted.filter((t) => !alleRows.some((r) => r.ticker === t))) {
        results.push({ ticker: t, uebersprungen: "keine Zeile in stock_analyses" });
        uebersprungen++;
      }
    }

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (row) => {
        const sym = await resolveFmpSymbol(
          row.ticker,
          (s) => fmpGet(`/profile?symbol=${encodeURIComponent(s)}`, schluessel, row.ticker),
        );
        const s = encodeURIComponent(sym);
        // Dieselben Abfragen wie in analyse/index.ts.
        const [income, balance, cashflow, estimates] = await Promise.all([
          fmpGet(`/income-statement?symbol=${s}&period=annual&limit=5`, schluessel, row.ticker),
          fmpGet(`/balance-sheet-statement?symbol=${s}&period=annual&limit=5`, schluessel, row.ticker),
          fmpGet(`/cash-flow-statement?symbol=${s}&period=annual&limit=5`, schluessel, row.ticker),
          fmpGet(`/analyst-estimates?symbol=${s}&period=annual&limit=4`, schluessel, row.ticker),
        ]);
        if ([income, balance, cashflow, estimates].some((r) => r.authError)) {
          results.push({ ticker: row.ticker, uebersprungen: "FMP-Schluessel ungueltig" });
          uebersprungen++;
          return;
        }
        // Ohne die drei Abschluesse waere der neue Score ein Artefakt der
        // fehlenden Daten, keine Korrektur. Schaetzungen duerfen fehlen, das
        // war schon bei der Analyse so.
        const fehlt = [["GuV", income], ["Bilanz", balance], ["Cashflow", cashflow]]
          .filter(([, r]) => !(r as FmpResult).ok || !Array.isArray((r as FmpResult).data) ||
            ((r as FmpResult).data as unknown[]).length === 0)
          .map(([n, r]) => `${n} (${(r as FmpResult).error ?? "leer"})`);
        if (fehlt.length) {
          results.push({ ticker: row.ticker, uebersprungen: `Abschluesse fehlen: ${fehlt.join(", ")}` });
          uebersprungen++;
          return;
        }

        const neu = rechneFundamental({ income, balance, cashflow, estimates });
        const ohne = rechneFundamental({ income, balance, cashflow: ohneDividendenfelder(cashflow), estimates });
        if (neu.score === null) {
          results.push({ ticker: row.ticker, uebersprungen: "Fundamentalscore nicht bestimmbar" });
          uebersprungen++;
          return;
        }

        const fAlt = num(row.score_fundamental);
        const totalAlt = num(row.score_total);
        const totalNeu = gesamtNeu(neu.score, row.score_qualitaet, row.score_krise, row.score_trend);
        const aendert = aendertSich(fAlt, row.criteria, neu);

        const eintrag: Record<string, unknown> = {
          ticker: row.ticker,
          f_alt: fAlt,
          f_neu: eineStelle(neu.score),
          // Zerlegung der Aenderung: was die Korrektur bewirkt, und was
          // neuere FMP-Daten bewirken (z. B. ein inzwischen erschienener
          // Jahresabschluss).
          effekt_dividende: eineStelle(neu.score - (ohne.score ?? neu.score)),
          effekt_daten: ohne.score !== null && fAlt !== null ? eineStelle(ohne.score - fAlt) : null,
          total_alt: totalAlt,
          total_neu: aendert ? totalNeu : totalAlt,
          delta: aendert && totalNeu !== null && totalAlt !== null ? totalNeu - totalAlt : 0,
          dividendenzahler: neu.dividendenzahler,
          dividenden_ampeln: neu.kriterien
            .filter((k) => DIVIDENDEN_KRITERIEN.includes(String(k.name)))
            .map((k) => ({ name: k.name, ampel: k.ampel, begruendung: k.begruendung })),
          letztes_jahr_alt: letztesJahr(row.chart_data),
          letztes_jahr_neu: neu.letztesJahr,
          // Nur gemeldet, nicht geschrieben: die Warnungen bleiben, wie sie
          // sind. Kippt dieser K.O.-Hinweis, braucht es eine Neuanalyse.
          ko_verschuldung_alt: hatKoVerschuldung(row.warnings),
          ko_verschuldung_neu: neu.koVerschuldung,
          ...(sym !== row.ticker ? { fmp_symbol: sym } : {}),
        };

        if (!aendert) {
          results.push({ ...eintrag, unveraendert: true });
          unveraendert++;
          return;
        }
        if (totalNeu === null) {
          results.push({ ...eintrag, uebersprungen: "Gesamtscore nicht bildbar (Teilscore fehlt)" });
          uebersprungen++;
          return;
        }
        if (dryRun) {
          results.push(eintrag);
          return;
        }

        const chartAlt = (row.chart_data ?? {}) as Record<string, unknown>;
        const flagsAlt = (chartAlt.data_flags ?? {}) as Record<string, unknown>;
        const chartNeu: Record<string, unknown> = {
          ...chartAlt,
          fundamentalSeries: neu.series,
          data_flags: { ...flagsAlt, fundamental_recalc_at: new Date().toISOString() },
        };

        const { data: applied, error: applyError } = await supabase.rpc("apply_fundamental", {
          p_ticker: row.ticker,
          p_expected_updated_at: row.updated_at,
          p_score_fundamental: Math.round(neu.score),
          p_score_total: totalNeu,
          p_criteria: kriterienErsetzen(row.criteria, neu.kriterien),
          p_chart_data: chartNeu,
        });
        if (applyError) {
          results.push({ ...eintrag, geschrieben: false, fehler: applyError.message });
          uebersprungen++;
          return;
        }
        geschrieben++;
        results.push({ ...eintrag, geschrieben: true, rpc: applied });
      }));
    }

    const geaendert = results.filter((r) => typeof r.f_neu === "number" && !r.unveraendert && !r.uebersprungen);
    const mittel = (feld: string, liste: Record<string, unknown>[]) => {
      const w = liste.map((r) => r[feld]).filter((v): v is number => typeof v === "number");
      return w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length * 100) / 100 : null;
    };
    return json({
      dry_run: dryRun,
      geprueft: rows.length,
      geschrieben,
      geaendert: geaendert.length,
      unveraendert,
      uebersprungen,
      dividendenzahler: results.filter((r) => r.dividendenzahler === true).length,
      mittlere_aenderung_gesamt: mittel("delta", geaendert),
      differenz_ueber_5_punkte: geaendert.filter((r) => Math.abs(r.delta as number) > 5).length,
      mittlerer_effekt_dividende: mittel("effekt_dividende", geaendert),
      mittlerer_effekt_daten: mittel("effekt_daten", geaendert),
      ko_verschuldung_gekippt: results.filter((r) =>
        typeof r.ko_verschuldung_alt === "boolean" && r.ko_verschuldung_alt !== r.ko_verschuldung_neu).length,
      ergebnisse: results.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logFunctionError(FUNCTION_NAME, auth.userId, message).catch(() => {});
    return json({ error: message }, 500);
  }
});
