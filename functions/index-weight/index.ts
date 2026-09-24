import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { INDEX_DEFINITIONS } from "../_shared/indexDefinitions.ts";
import { getSp500Weight, getNasdaq100Weight, getDowJonesWeight } from "../_shared/indexWeight.ts";

// getIndexWeighting(ticker): liefert fuer einen Ticker die Gewichtung(en)
// in den Indizes, in denen er laut der bereits vorhandenen Tabelle
// index_constituents Mitglied ist. Rein informative Zusatzanzeige auf der
// Analyse-Seite - kein Einfluss auf Score/Sortierung, keine Speicherung
// (Auftrag). DAX/MDAX/SDAX sind wie ueberall sonst deaktiviert
// (INDEX_DEFINITIONS.enabled), werden hier also nie geprueft.
//
// Ablauf: erst in index_constituents nachsehen, in welchen (aktivierten)
// Indizes der Ticker ueberhaupt Mitglied ist (vermeidet unnoetige Live-
// Abrufe der ETF-Holdings-Dateien fuer Indizes, in denen der Ticker gar
// nicht vorkommt), dann fuer jeden Treffer parallel die passende Getter-
// Funktion aus _shared/indexWeight.ts aufrufen. Jede Getter-Funktion gibt
// bei jedem Fehler bereits null zurueck (siehe dortige Kommentare) - hier
// wird nur noch das Nasdaq-100-Ergebnis vorab ausgefiltert, weil es
// bewusst IMMER null ist (kein Log-Rauschen fuer einen erwarteten Fall).

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const WEIGHT_GETTERS: Record<string, (ticker: string) => Promise<number | null>> = {
  sp500: getSp500Weight,
  nasdaq100: getNasdaq100Weight,
  dowjones: getDowJonesWeight,
};

interface Weighting {
  index_id: string;
  label: string;
  weight_pct: number;
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

  const body = await req.json().catch(() => ({}));
  const ticker = (body.ticker ?? "").toString().trim().toUpperCase();
  if (!ticker) {
    return new Response(JSON.stringify({ error: "ticker fehlt." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: memberships, error } = await supabase
    .from("index_constituents")
    .select("index_id")
    .eq("ticker", ticker);

  if (error) {
    console.error(`[index-weight] Mitgliedschafts-Abfrage fehlgeschlagen fuer ${ticker}:`, error.message);
    return new Response(JSON.stringify({ ticker, weightings: [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const enabledIds = new Set(INDEX_DEFINITIONS.filter((d) => d.enabled).map((d) => d.id));
  const indexIds = [...new Set((memberships ?? []).map((m) => m.index_id))].filter(
    (id) => enabledIds.has(id) && WEIGHT_GETTERS[id],
  );

  const weightings = (
    await Promise.all(
      indexIds.map(async (indexId) => {
        const weight = await WEIGHT_GETTERS[indexId](ticker);
        if (weight === null) return null;
        const def = INDEX_DEFINITIONS.find((d) => d.id === indexId)!;
        return { index_id: indexId, label: def.label, weight_pct: weight } satisfies Weighting;
      }),
    )
  ).filter((w): w is Weighting => w !== null);

  return new Response(JSON.stringify({ ticker, weightings }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
