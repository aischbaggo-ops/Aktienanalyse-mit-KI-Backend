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

function mapResults(data: unknown): SearchResult[] {
  return (Array.isArray(data) ? data : []).map((r: any) => ({
    symbol: r.symbol,
    name: r.name,
    currency: r.currency || null,
    exchange: r.exchangeShortName || r.stockExchange || null,
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
      results: results.slice(0, 15),
      rate_limited: rateLimited,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
