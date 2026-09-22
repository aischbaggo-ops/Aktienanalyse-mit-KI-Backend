import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { findIndexDefinition, INDEX_DEFINITIONS } from "../_shared/indexDefinitions.ts";

// getIndexConstituents(indexId): liefert die Mitgliederliste eines Index
// fuer die Batch-Auswahl, ausschliesslich aus der manuell gepflegten
// Tabelle index_constituents (Seed-Daten aus Wikipedia).
//
// FMP wird hier bewusst NICHT versucht: die Konstituenten-Endpoints
// (sp500-constituent/nasdaq-constituent/dowjones-constituent) liefern im
// Free-Plan HTTP 402, live getestet 2026-09-22 - ein FMP-Versuch wuerde
// fuer jeden Index fehlschlagen. Falls der FMP-Plan spaeter erweitert
// wird, kann hier wieder ein FMP-Versuch vor dem Fallback ergaenzt werden.
//
// Bekannte Einschraenkung (bewusste Entscheidung): Wikipedia liefert keine
// Indexgewichtung. "Top N" ist daher schlicht "die ersten N Eintraege in
// der beim Seed erfassten (Wikipedia-)Reihenfolge", nicht nach
// Marktkapitalisierung sortiert.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export interface Constituent {
  rank: number;
  ticker: string;
  name: string;
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
    // Trifft auch fuer einen deaktivierten Index (DAX/MDAX/SDAX) zu, nicht
    // nur fuer einen unbekannten - findIndexDefinition() liefert fuer beide
    // Faelle undefined. Absichtlich, siehe Kommentar in indexDefinitions.ts.
    const known = INDEX_DEFINITIONS.filter((d) => d.enabled).map((d) => d.id).join(", ");
    return new Response(
      JSON.stringify({
        error: `Unbekannter oder aktuell nicht verfuegbarer Index "${indexId}". Verfuegbar: ${known}.`,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const constituents = await fetchFromFallbackTable(indexId);

  if (constituents.length === 0) {
    await logFunctionError("index-constituents", userId, `Keine Konstituenten in der Fallback-Tabelle fuer indexId=${indexId}.`);
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
      source: "fallback",
      // Reihenfolge wie beim Seed erfasst (Wikipedia) - keine Gewichtungs-
      // daten verfuegbar, siehe Kommentar am Dateianfang.
      constituents: result,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
