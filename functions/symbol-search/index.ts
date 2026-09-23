import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";

const FMP_BASE = "https://financialmodelingprep.com/stable";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Pentest-Scratchpad M1 - eigener Richtwert, im Auftrag nicht vorgegeben.
const MAX_SEARCHES_PER_HOUR = 60;

interface SearchResult {
  symbol: string;
  name: string;
  currency: string | null;
  exchange: string | null;
}

// Live gegen FMP getestet (2026-09-16): search-symbol/search-name liefern
// das Feld direkt als "exchange" (z.B. "NASDAQ", "XETRA", "NEO", "OTC") -
// "exchangeShortName"/"stockExchange" existieren auf der Live-Antwort nicht
// und lieferten hier bisher immer null (unbenutzter Altbug, da exchange im
// Frontend bislang nirgends angezeigt wurde).
function mapResults(data: unknown): SearchResult[] {
  return (Array.isArray(data) ? data : []).map((r: any) => ({
    symbol: r.symbol,
    name: r.name,
    currency: r.currency || null,
    exchange: r.exchange || null,
  }));
}

interface FmpSearchOutcome {
  results: SearchResult[];
  rateLimited: boolean;
}

async function fmpSearch(endpoint: string, query: string, fmpKey: string): Promise<FmpSearchOutcome> {
  try {
    const res = await fetch(`${FMP_BASE}/${endpoint}?query=${encodeURIComponent(query)}&apikey=${fmpKey}`);
    if (res.status === 429) return { results: [], rateLimited: true };
    if (!res.ok) return { results: [], rateLimited: false };
    return { results: mapResults(await res.json()), rateLimited: false };
  } catch {
    return { results: [], rateLimited: false };
  }
}

// Kennzeichnet die "Hauptaktie" in der Trefferliste (Stern im Frontend),
// ohne irgendetwas herauszufiltern. FMPs search-symbol/search-name liefern
// keinen Typ-Indikator (Aktie vs. ETF/Fonds - live geprueft, nicht in der
// Doku und nicht in der Antwort enthalten), daher rein ueber Notierungs-
// Merkmale: kein Bindestrich-Suffix am Ticker (FMP haengt Zweitnotierungen
// immer als Suffix an, z.B. NVDA.NE/NVD.DE - die Heimatnotierung bleibt
// suffixfrei), USD als Waehrung, und NASDAQ/NYSE als Boerse (die beiden
// primaeren US-Boersen). Nur der ERSTE Treffer, der alle drei Kriterien
// erfuellt, wird markiert.
//
// Wichtig: laeuft ueber die VOLLE deduplizierte Liste, nicht erst nach dem
// Anzeige-Zuschnitt auf 15 Treffer. Fund vom 16.9. (Suche "VISA"): FMPs
// eigenes Relevanz-Ranking stellt bei kurzen/abweichenden Tickern (Visas
// echter Ticker ist "V") Treffer mit Textaehnlichkeit zum Suchbegriff
// (VISAX, VISA.NE, VISAGAR.BO, ...) vor die eigentliche Firma - "V" selbst
// landete dadurch erst auf Position 16 von 31, ausserhalb des 15er-
// Fensters. Wird der Primaer-Treffer erst nach dem Zuschnitt gesucht, wird
// er nie gefunden UND dem Nutzer nie angezeigt. Das generelle FMP-Ranking-
// Problem (viele Treffer vor der Aktie bei kurzen Tickern) bleibt bewusst
// unangetastet, nur fuer den erkannten Primaer-Treffer wird eine Ausnahme
// gemacht: liegt er ausserhalb der sichtbaren Top 15, wird er an den
// Anfang gezogen, statt ihn dem Nutzer vorzuenthalten.
const PRIMARY_EXCHANGES = new Set(["NASDAQ", "NYSE"]);
const RESULT_LIMIT = 15;
// Fund/ETF-Namen koennen dieselben Notierungs-Merkmale wie eine echte Aktie
// haben (kein Suffix, USD, NASDAQ) - z.B. "VISAX" (ein Fonds) bei der Suche
// "VISA", waehrend Visa Inc. selbst Ticker "V" traegt. Ohne Typ-Indikator
// von FMP (siehe Kommentar oben) ist der Name das einzige verfuegbare
// Signal dagegen. Bewusst simpel/unvollstaendig (z.B. manche REITs heissen
// legitim "... Trust") - reicht als Faustregel, filtert nichts heraus,
// nur fuer die Sternvergabe relevant.
const FUND_NAME_PATTERN = /\b(fund|etf|trust|shares|portfolio)\b/i;

function markPrimary(results: SearchResult[]): (SearchResult & { isPrimary: boolean })[] {
  let marked = false;
  return results.map((r) => {
    const isPrimary =
      !marked &&
      !r.symbol.includes(".") &&
      r.currency === "USD" &&
      r.exchange !== null &&
      PRIMARY_EXCHANGES.has(r.exchange) &&
      !FUND_NAME_PATTERN.test(r.name);
    if (isPrimary) marked = true;
    return { ...r, isPrimary };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const auth = await verifyUser(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { userId } = auth;

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim();

  if (!query) {
    return new Response(JSON.stringify({ results: [], rate_limited: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Sucht laufen jetzt gegen den eigenen FMP-Key des Nutzers statt gegen
  // einen gemeinsamen Service-Key - kein automatischer Rueckfall, wenn er
  // fehlt (sonst waere der Zweck der Umstellung unterlaufen).
  const { fmpKey } = await loadUserApiKeys(userId);
  if (!fmpKey) {
    return new Response(
      JSON.stringify({ error: "Bitte hinterlege zuerst deinen eigenen FMP-API-Key in den Einstellungen." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Rate-Limit (Pentest-Scratchpad M1) - VOR den FMP-Calls, damit ein
  // ueberzogenes Limit auch tatsaechlich den externen Aufruf spart, nicht
  // nur die Antwort. 60/Stunde ist grosszuegiger als bei analyse (jede
  // Sucheingabe im Frontend loest einen Call aus, auch Tippen mehrerer
  // Buchstaben nacheinander) - eigener Richtwert, im Auftrag nicht
  // vorgegeben.
  const searchRateLimitCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentSearchCount } = await supabase
    .from("search_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("requested_at", searchRateLimitCutoff);
  if ((recentSearchCount ?? 0) >= MAX_SEARCHES_PER_HOUR) {
    return new Response(
      JSON.stringify({ error: `Zu viele Suchanfragen (max. ${MAX_SEARCHES_PER_HOUR}/Stunde). Bitte kurz warten.` }),
      { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Ticker-Praefixtreffer (search-symbol) UND Firmennamen-Treffer
  // (search-name) parallel abfragen - Ticker-Treffer haben Vorrang (kommen
  // zuerst in der Ergebnisliste), Namens-Treffer ergaenzen fuer Eingaben wie
  // "Apple" oder "Henkel", bei denen kein Ticker getippt wird. Nach Symbol
  // dedupliziert, falls derselbe Ticker in beiden Antworten auftaucht.
  const [tickerMatches, nameMatches] = await Promise.all([
    fmpSearch("search-symbol", query, fmpKey),
    fmpSearch("search-name", query, fmpKey),
  ]);

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const r of [...tickerMatches.results, ...nameMatches.results]) {
    if (!r.symbol || seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    results.push(r);
  }

  const rateLimited = tickerMatches.rateLimited || nameMatches.rateLimited;

  // Fuer den Auslastungstracker im Admin-Dashboard - separate Tabelle statt
  // request_log (siehe Migration), Logging-Fehler duerfen die eigentliche
  // Suche nicht beeintraechtigen. user_id seit Pentest-Scratchpad M1
  // (Migration 20260923120000) - wird fuer das Rate-Limit oben gebraucht,
  // "on delete cascade" raeumt die Zeilen bei einer Kontoloeschung
  // automatisch mit auf.
  try {
    await supabase.from("search_log").insert({ query, rate_limited: rateLimited, user_id: userId });
  } catch {
    // ignorieren
  }

  const markedAll = markPrimary(results);
  const primaryIdx = markedAll.findIndex((r) => r.isPrimary);
  if (primaryIdx >= RESULT_LIMIT) {
    const [primary] = markedAll.splice(primaryIdx, 1);
    markedAll.unshift(primary);
  }

  return new Response(
    JSON.stringify({
      results: markedAll.slice(0, RESULT_LIMIT),
      rate_limited: rateLimited,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
