import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { findIndexDefinition, INDEX_DEFINITIONS } from "../_shared/indexDefinitions.ts";

// getIndexConstituents(indexId): liefert die Mitgliederliste eines Index
// fuer die Batch-Auswahl. Reihenfolge: zuerst FMP versuchen (falls fuer
// diesen Index bereits ein bestaetigter Endpoint hinterlegt ist, siehe
// indexDefinitions.ts), sonst/bei leerem Ergebnis Fallback auf die manuell
// gepflegte Tabelle index_constituents.
//
// Bekannte Einschraenkung (bewusste Entscheidung, siehe Uebergabe-Notiz):
// FMPs Konstituenten-Endpoints liefern keine Gewichtung. "Top N" ist daher
// schlicht "die ersten N Eintraege in der von der Quelle gelieferten
// Reihenfolge", nicht nach Marktkapitalisierung sortiert.

const FMP_BASE = "https://financialmodelingprep.com/stable";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export interface Constituent {
  rank: number;
  ticker: string;
  name: string;
}

// TODO nach Probe-Test: Feldnamen anhand der echten FMP-Antwort pruefen.
// symbol-search zeigt, dass FMP-Feldnamen von der Doku abweichen koennen
// (z.B. "exchange" statt "exchangeShortName") - vor Aktivierung eines
// fmpPath in indexDefinitions.ts hier gegenpruefen, nicht blind uebernehmen.
function mapFmpRow(row: any, idx: number): Constituent | null {
  const ticker = row?.symbol ?? row?.ticker;
  const name = row?.name ?? row?.companyName;
  if (!ticker) return null;
  return { rank: idx + 1, ticker: String(ticker), name: name ? String(name) : String(ticker) };
}

async function fetchFromFmp(fmpPath: string, fmpKey: string): Promise<Constituent[] | null> {
  try {
    const res = await fetch(`${FMP_BASE}${fmpPath}${fmpPath.includes("?") ? "&" : "?"}apikey=${fmpKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    return data.map(mapFmpRow).filter((c): c is Constituent => c !== null);
  } catch {
    return null;
  }
}

async function fetchFromFallbackTable(indexId: string): Promise<Constituent[]> {
  const { data, error } = await supabase
    .from("index_constituents")
    .select("rank, ticker, name")
    .eq("index_id", indexId)
    .order("rank", { ascending: true });
  if (error) {
    console.error(`[index-constituents] fallback query failed indexId=${indexId}:`, error.message);
    return [];
  }
  return data ?? [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const auth = await verifyUser(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { userId } = auth;

  const body = await req.json().catch(() => ({}));
  const indexId = (body.index_id ?? "").toString().trim().toLowerCase();
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : null;

  const def = findIndexDefinition(indexId);
  if (!def) {
    return new Response(
      JSON.stringify({
        error: `Unbekannter Index "${indexId}". Bekannt: ${INDEX_DEFINITIONS.map((d) => d.id).join(", ")}.`,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let constituents: Constituent[] | null = null;
  let source: "fmp" | "fallback" | "none" = "none";

  if (def.fmpPath) {
    const { fmpKey } = await loadUserApiKeys(userId);
    if (fmpKey) {
      constituents = await fetchFromFmp(def.fmpPath, fmpKey);
      if (constituents) source = "fmp";
    }
  }

  if (!constituents || constituents.length === 0) {
    const fallback = await fetchFromFallbackTable(indexId);
    if (fallback.length > 0) {
      constituents = fallback;
      source = "fallback";
    }
  }

  if (!constituents || constituents.length === 0) {
    await logFunctionError(
      "index-constituents",
      userId,
      `Keine Konstituenten verfuegbar fuer indexId=${indexId} (fmpPath=${def.fmpPath ?? "n/a"}).`,
    );
    return new Response(
      JSON.stringify({
        index_id: indexId,
        label: def.label,
        source: "none",
        constituents: [],
        note: "Für diesen Index sind aktuell keine Daten verfügbar.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const result = limit ? constituents.slice(0, limit) : constituents;

  return new Response(
    JSON.stringify({
      index_id: indexId,
      label: def.label,
      source,
      // Reihenfolge wie von der Datenquelle geliefert - keine Gewichtungs-
      // daten verfuegbar, siehe Kommentar am Dateianfang.
      constituents: result,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
