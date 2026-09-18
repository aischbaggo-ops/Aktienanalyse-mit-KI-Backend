import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { requireAdmin } from "../_shared/adminGate.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { PRICING } from "../_shared/claude.ts";

const CHAT_MODEL = "claude-sonnet-5";

// Harte Obergrenze pro Anfrage, unabhaengig vom Frontend - begrenzt die
// maximalen Kosten EINES einzelnen Turns, falls Claude sich in einer
// Recherche "verrennt". Anthropic-Richtwert: einfache Faktenfragen
// brauchen 1-3 Suchen, vergleichende Recherche auch mal 10+ - 5 ist ein
// vorsichtiger Mittelwert fuer v1, bei Bedarf spaeter anpassen.
const MAX_WEB_SEARCHES_PER_TURN = 5;

// Web-Search wird von Anthropic ZUSAETZLICH zum normalen Token-Preis
// abgerechnet ($10 pro 1000 Suchen = $0.01/Suche, Stand Anthropic-
// Preisliste September 2026, siehe "Usage and pricing" in der Web-Search-
// Tool-Doku) - unabhaengig von PRICING aus _shared/claude.ts, das nur
// Input-/Output-Token abdeckt.
const WEB_SEARCH_COST_PER_USE = 0.01;

interface ChatMessage {
  role: "user" | "assistant";
  // string fuer einfache User-Turns, ODER das unveraendert zurueckgegebene
  // content-Array einer frueheren Antwort dieser Function (siehe Hinweis
  // bei der Response weiter unten) - wird 1:1 an Anthropic durchgereicht.
  content: unknown;
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
  const userId = auth.userId;

  // Admin-Gate VOR jedem kostenpflichtigen Call - siehe _shared/adminGate.ts.
  const admin = await requireAdmin(userId);
  if (!admin.ok) {
    return new Response(JSON.stringify({ error: admin.error }), {
      status: admin.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : null;
  if (!messages || messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages fehlt oder ist leer." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Eigener Claude-Key des Admins, wie bei analyse - kein globaler
  // Service-Key.
  const { claudeKey } = await loadUserApiKeys(userId);
  if (!claudeKey) {
    return new Response(
      JSON.stringify({ error: "Bitte hinterlege zuerst deinen eigenen Claude-API-Key in den Einstellungen." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let claudeRaw: any;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        max_tokens: 4096,
        messages,
        // web_search_20250305: Basis-Websuche, serverseitig von Anthropic
        // ausgefuehrt - kein eigener Such-Provider noetig. Anthropic macht
        // die Suchen automatisch waehrend dieses EINEN Requests, kein
        // zusaetzlicher Tool-Result-Roundtrip wie bei einem Custom-Tool.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES_PER_TURN }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${text}`);
    }
    claudeRaw = await res.json();
  } catch (e) {
    const message = (e as Error).message;
    await logFunctionError("admin-chat", userId, message);
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const usage = claudeRaw.usage || {};
  const tokensInput = usage.input_tokens || 0;
  const tokensOutput = usage.output_tokens || 0;
  const webSearchCount = usage.server_tool_use?.web_search_requests || 0;
  const rates = PRICING[CHAT_MODEL] || PRICING["claude-sonnet-5"];
  const costUsd =
    (tokensInput * rates.in + tokensOutput * rates.out) / 1_000_000 + webSearchCount * WEB_SEARCH_COST_PER_USE;

  return new Response(
    JSON.stringify({
      // Bewusst das ROHE content-Array, nicht auf reinen Anzeige-Text
      // reduziert: enthaelt bei einer Websuche zusaetzlich
      // server_tool_use-/web_search_tool_result-Bloecke mit
      // encrypted_content. Anthropic verlangt, dass diese Bloecke bei einem
      // Folge-Turn EXAKT unveraendert als Assistant-Message zurueckgeschickt
      // werden (sonst 400 auf den naechsten Call) - Schritt 2 muss beim
      // Verwalten des Chat-Verlaufs im Frontend also dieses ganze Array
      // speichern und wieder mitschicken, nicht nur den extrahierten Text.
      content: claudeRaw.content ?? [],
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      web_search_count: webSearchCount,
      cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
