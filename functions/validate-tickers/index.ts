import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";

// Prueft eine Liste von Ticker-KANDIDATEN (z.B. aus dem Freitext-Parser,
// siehe tickerParser.ts) gegen echte FMP-Profildaten, BEVOR sie in einen
// Batch-Lauf uebernommen werden. Ohne diese Pruefung akzeptierte
// "Ticker erkennen" frei erfundene Eingaben wie "zzzz" -> "ZZZZ" oder
// Firmennamen-Fragmente wie "WALLETUSD" unbesehen - die landeten dann als
// Muell-Eintraege in "Letzte Analysen" (reales Testfeedback).
//
// EIN Bulk-FMP-Call statt N Einzelaufrufe: /profile akzeptiert mehrere
// kommagetrennte Symbole in einer Anfrage und liefert nur die tatsaechlich
// existierenden zurueck (unbekannte Symbole werden schlicht weggelassen,
// kein Fehler) - dasselbe Verhalten, auf dem analyse/index.ts's fmpGet()
// fuer den Einzel-Ticker-Fall bereits aufbaut. Vermeidet ausserdem, das
// bestehende Rate-Limit von symbol-search (60/Stunde) mit bis zu
// MAX_BATCH_SIZE=100 Einzelsuchen pro Klick zu sprengen.
const FMP_BASE = "https://financialmodelingprep.com/stable";
const MAX_TICKERS = 100;

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
  const tickersRaw = Array.isArray(body.tickers) ? body.tickers : [];
  const tickers = [
    ...new Set(
      tickersRaw
        .map((t: unknown) => String(t).trim().toUpperCase())
        .filter((t: string) => t.length > 0),
    ),
  ].slice(0, MAX_TICKERS);

  if (tickers.length === 0) {
    return new Response(JSON.stringify({ valid: [] }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { fmpKey } = await loadUserApiKeys(auth.userId);
  if (!fmpKey) {
    return new Response(
      JSON.stringify({ error: "Bitte hinterlege zuerst deinen eigenen FMP-API-Key in den Einstellungen." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Validierung ist ein ZUSATZ-Schutz, kein harter Blocker fuer den Rest der
  // App - schlaegt der FMP-Call selbst fehl (Netzwerk, ungueltiger Key),
  // bekommt der Client einen klaren Fehler und entscheidet selbst, ob er
  // ungeprueft fortfaehrt, statt dass ein FMP-Ausfall die gesamte
  // Batch-Funktion lahmlegt.
  try {
    const url = `${FMP_BASE}/profile?symbol=${tickers.map(encodeURIComponent).join(",")}&apikey=${fmpKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      return new Response(JSON.stringify({ error: `FMP-Antwort ${res.status}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const data = await res.json();
    const validSymbols = new Set(
      (Array.isArray(data) ? data : [])
        .map((p: any) => String(p?.symbol ?? "").toUpperCase())
        .filter((s: string) => s.length > 0),
    );
    const valid = tickers.filter((t) => validSymbols.has(t));
    return new Response(JSON.stringify({ valid }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
