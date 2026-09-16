import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const FMP_API_KEY = Deno.env.get("FMP_API_KEY")!;
const FMP_BASE = "https://financialmodelingprep.com/stable";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

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

async function fmpSearch(endpoint: string, query: string): Promise<FmpSearchOutcome> {
  try {
    const res = await fetch(`${FMP_BASE}/${endpoint}?query=${encodeURIComponent(query)}&apikey=${FMP_API_KEY}`);
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
// erfuellt, wird markiert - die Ergebnisliste ist bereits relevanzsortiert
// (Ticker-Exakttreffer zuerst), ein gleichnamiger Fonds/ETF mit denselben
// Oberflaechen-Merkmalen (z.B. "APPLX" bei einer "apple"-Suche) taucht
// dadurch typischerweise erst nach der echten Aktie auf.
const PRIMARY_EXCHANGES = new Set(["NASDAQ", "NYSE"]);

function markPrimary(results: SearchResult[]): (SearchResult & { isPrimary: boolean })[] {
  let marked = false;
  return results.map((r) => {
    const isPrimary =
      !marked &&
      !r.symbol.includes(".") &&
      r.currency === "USD" &&
      r.exchange !== null &&
      PRIMARY_EXCHANGES.has(r.exchange);
    if (isPrimary) marked = true;
    return { ...r, isPrimary };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim();

  if (!query) {
    return new Response(JSON.stringify({ results: [], rate_limited: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Ticker-Praefixtreffer (search-symbol) UND Firmennamen-Treffer
  // (search-name) parallel abfragen - Ticker-Treffer haben Vorrang (kommen
  // zuerst in der Ergebnisliste), Namens-Treffer ergaenzen fuer Eingaben wie
  // "Apple" oder "Henkel", bei denen kein Ticker getippt wird. Nach Symbol
  // dedupliziert, falls derselbe Ticker in beiden Antworten auftaucht.
  const [tickerMatches, nameMatches] = await Promise.all([
    fmpSearch("search-symbol", query),
    fmpSearch("search-name", query),
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
  // Suche nicht beeintraechtigen.
  try {
    await supabase.from("search_log").insert({ query, rate_limited: rateLimited });
  } catch {
    // ignorieren
  }

  return new Response(
    JSON.stringify({
      results: markPrimary(results.slice(0, 15)),
      rate_limited: rateLimited,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
