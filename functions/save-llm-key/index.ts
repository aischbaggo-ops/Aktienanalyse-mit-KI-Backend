import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { encryptSecret } from "../_shared/crypto.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { LLM_PROVIDERS, type LlmProvider } from "../_shared/llm/types.ts";
import { validateLlmKey } from "../_shared/llm/validateKey.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Speichert (upsert) den API-Key + optionalen Modellnamen EINES LLM-
// Anbieters fuer den eingeloggten Nutzer - unabhaengig pro Anbieter
// aufrufbar, ohne ihn dadurch gleich als aktiv zu setzen (das passiert
// separat ueber die RPC set_active_llm_provider, siehe Migration
// 20260924100500). Gleiches Verschluesselungs-/Muster wie save-api-keys.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
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
  const provider = (body.provider ?? "").toString().trim() as LlmProvider;
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  // Leerer String -> null (Feld bewusst nicht gesetzt), nicht "" speichern.
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;

  if (!LLM_PROVIDERS.includes(provider)) {
    return new Response(JSON.stringify({ error: `Unbekannter Anbieter: "${provider}".` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Bestehende Zeile EINMAL laden - wird fuer zwei Faelle gebraucht: (a) ein
  // leeres Key-Feld ("nur Modell aendern") braucht sie, um zu wissen, dass
  // ueberhaupt ein bestehender Key da ist; (b) ein leeres Modell-Feld (egal
  // ob Key- oder Modell-Aenderung) soll den zuvor gespeicherten Modellnamen
  // NICHT loeschen (Fallback statt Ueberschreiben mit null) - sonst wuerde
  // z.B. eine reine Key-Rotation ohne erneute Modell-Eingabe den gespeicherten
  // Modellnamen fuer nicht-Claude-Anbieter wieder auf null zuruecksetzen.
  const { data: existing, error: fetchError } = await adminClient
    .from("user_llm_keys")
    .select("model")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (fetchError) {
    await logFunctionError("save-llm-key", userId, fetchError.message, provider);
    return new Response(JSON.stringify({ error: `Speichern fehlgeschlagen: ${fetchError.message}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const effectiveModel = model ?? existing?.model ?? null;

  // Bei allen Anbietern ausser Claude ist der Modellname Pflicht (siehe
  // Migration 20260924100000 - fuer Claude greift ohne Eintrag der
  // Code-Default in _shared/llm/claude.ts).
  if (provider !== "claude" && !effectiveModel) {
    return new Response(
      JSON.stringify({ error: "Bitte gib einen Modellnamen an (bei diesem Anbieter Pflichtfeld)." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Leeres Key-Feld -> nur der Modellname soll aktualisiert werden (siehe
  // Platzhalter-Text im Frontend "Neuen Key eingeben, um zu ersetzen" -
  // leer bedeutet bestehenden Key behalten). Ciphertext/IV/last4 bleiben
  // dabei unangetastet. Ohne bestehende Zeile ist ein Key aber Pflicht.
  if (!apiKey) {
    if (!existing) {
      return new Response(JSON.stringify({ error: "Kein API-Key uebergeben." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error } = await adminClient
      .from("user_llm_keys")
      .update({ model: effectiveModel, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("provider", provider);
    if (error) {
      await logFunctionError("save-llm-key", userId, error.message, provider);
      return new Response(JSON.stringify({ error: `Speichern fehlgeschlagen: ${error.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Neuer Key -> vor dem Verschluesseln mit einem leichten, kostenlosen
  // Call gegen die echte Anbieter-API pruefen, statt einen ggf. kaputten
  // Key ungeprueft zu speichern (siehe validateKey.ts).
  const validation = await validateLlmKey(provider, apiKey);
  if (!validation.ok) {
    return new Response(JSON.stringify({ error: validation.error }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { ciphertext, iv } = await encryptSecret(apiKey);
  const row = {
    user_id: userId,
    provider,
    key_ciphertext: ciphertext,
    key_iv: iv,
    key_last4: apiKey.slice(-4),
    model: effectiveModel,
    updated_at: new Date().toISOString(),
  };

  const { error } = await adminClient.from("user_llm_keys").upsert(row, { onConflict: "user_id,provider" });
  if (error) {
    await logFunctionError("save-llm-key", userId, error.message, provider);
    return new Response(JSON.stringify({ error: `Speichern fehlgeschlagen: ${error.message}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
