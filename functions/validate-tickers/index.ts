import { corsFor } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";
import { logApiCall } from "../_shared/apiCallLog.ts";
import { checkTickers, failureMessage } from "../_shared/tickerCheck.ts";
import { findeKollisionen, istPunktlos, type Konstituent } from "../_shared/kollision.ts";
import type { FmpResultLike } from "../_shared/fmpStatus.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Prueft eine Liste von Ticker-KANDIDATEN (z.B. aus dem Freitext-Parser,
// siehe tickerParser.ts) gegen echte FMP-Profildaten, BEVOR sie in einen
// Batch-Lauf uebernommen werden. Ohne diese Pruefung akzeptierte
// "Ticker erkennen" frei erfundene Eingaben wie "zzzz" -> "ZZZZ" oder
// Firmennamen-Fragmente wie "WALLETUSD" unbesehen - die landeten dann als
// Muell-Eintraege in "Letzte Analysen" (reales Testfeedback).
//
// Einzelabfragen /profile?symbol=X (begrenzt parallel) statt einer
// Sammelabfrage mit kommagetrennten Symbolen: die Sammelabfrage lieferte
// keine verwertbare Trefferliste mehr, "Ticker erkennen" verwarf deshalb
// ALLE Eintraege (siehe _shared/tickerCheck.ts). Bei bis zu 100 Tickern sind
// das 100 Aufrufe, weit unter 3.000/min (Ultimate) - und kein Aufruf geht
// ueber symbol-search (60/Stunde).
const FMP_BASE = "https://financialmodelingprep.com/stable";
const MAX_TICKERS = 100;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Alle Indexeintraege MIT Boersenzusatz - nur die koennen einen punktlosen
// Kandidaten verdraengen. Das sind knapp hundert Zeilen (DAX und MDAX, spaeter
// SDAX), eine einzige Abfrage ohne Filterbasteleien. Faellt sie aus, entfaellt
// die Warnung; die Pruefung selbst bleibt gueltig - fail-open wie der Rest
// dieser Function.
async function ladeZwillinge(kandidaten: string[]): Promise<Konstituent[]> {
  if (!kandidaten.some(istPunktlos)) return [];
  // Die Spalte heisst "name", nicht "company_name" - ein falsch geratener
  // Spaltenname hat die Warnung beim ersten Deploy still verschluckt
  // (23.10.2026, fail-open: Pruefung lief, Warnung fehlte).
  const { data, error } = await supabase
    .from("index_constituents").select("ticker, name").like("ticker", "%.%");
  if (error) {
    console.warn(`[validate-tickers] Indexlisten nicht lesbar: ${error.message}`);
    return [];
  }
  const zeilen = (data ?? []) as { ticker: string; name: string | null }[];
  // Keine einzige Zeile mit Boersenzusatz waere kein normaler Zustand,
  // sondern ein Hinweis auf leere oder umbenannte Indexlisten. Ohne diese
  // Meldung faellt der Schutz lautlos aus - genau das ist beim ersten
  // Deploy passiert.
  if (zeilen.length === 0) {
    console.warn("[validate-tickers] index_constituents enthaelt keine Ticker mit Boersenzusatz - " +
      "Kollisionswarnung ist wirkungslos.");
  }
  return zeilen.map((r) => ({ ticker: r.ticker, company_name: r.name })) as Konstituent[];
}

Deno.serve(async (req) => {
  const corsHeaders = corsFor(req);
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
  const tickers: string[] = [
    ...new Set<string>(
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
  // App - schlaegt die Pruefung fehl (Netzwerk, Key, Plan, Limit, keine
  // verwertbare Antwort), bekommt der Client einen klaren Fehler und
  // entscheidet selbst, ob er ungeprueft fortfaehrt, statt dass ein
  // FMP-Problem die gesamte Batch-Funktion lahmlegt.
  const startedAt = Date.now();
  // Diagnose: Status + Anfang der ersten Antwort ohne Treffer (max. 300
  // Zeichen; der Key steht nie im Body, wird aber trotzdem geschwaerzt).
  let sample: string | null = null;
  const fetchProfile = async (symbol: string): Promise<FmpResultLike> => {
    const url = `${FMP_BASE}/profile?symbol=${encodeURIComponent(symbol)}&apikey=${fmpKey}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      return { ok: false, status: null, error: (e as Error).message };
    }
    const text = await res.text().catch(() => "");
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Klartext-Antwort (z. B. "Restricted"): bleibt als String.
    }
    if (!(Array.isArray(data) && data.length > 0) && sample === null) {
      sample = `${symbol} -> HTTP ${res.status}: ${text.replace(/apikey=[^&\s"]+/gi, "apikey=***").slice(0, 300)}`;
    }
    return { ok: res.ok, data, status: res.status, authError: res.status === 401 || res.status === 403 };
  };

  try {
    const r = await checkTickers(tickers, fetchProfile);
    await logApiCall({
      functionName: "validate-tickers",
      provider: "fmp",
      callType: "/profile (Einzelabfragen)",
      success: r.failure === null,
      durationMs: Date.now() - startedAt,
      errorMessage: `symbole=${tickers.length}; treffer=${r.valid.length}; aufrufe=${r.calls}; fehler=${r.failure ?? "-"}${
        r.failureStatus ? `; status=${r.failureStatus}` : ""
      }${sample && (r.failure || r.valid.length < tickers.length) ? `; probe=${sample}` : ""}`,
    });
    if (r.failure) {
      return new Response(JSON.stringify({ error: failureMessage(r.failure, r.failureStatus), code: r.failure }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Kollisionswarnung: ein punktloses Kuerzel, zu dem es einen
    // Indexeintrag MIT Endung gibt, ist fast immer ein Versehen - FMP
    // liefert dann das gleichnamige US-Papier (21.10.2026: 14 fremde Firmen
    // in der Datenbank). Der Ticker bleibt gueltig, der Client nimmt ihn nur
    // aus der Vorauswahl und bietet die Schreibweise mit Endung an.
    const kollisionen = findeKollisionen(r.valid, await ladeZwillinge(r.valid), r.profiles);
    if (kollisionen.length > 0) {
      console.log(`[validate-tickers] ${kollisionen.length} moegliche Verwechslung(en): ` +
        kollisionen.map((k) => `${k.eingabe}->${k.vorschlag}`).join(", "));
    }
    return new Response(JSON.stringify({ valid: r.valid, fmp_symbols: r.fmpSymbols, kollisionen }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
