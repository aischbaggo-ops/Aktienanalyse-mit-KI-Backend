import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { encryptSecret } from "../_shared/crypto.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
  const fmpKey = typeof body.fmp_api_key === "string" ? body.fmp_api_key.trim() : "";
  const claudeKey = typeof body.claude_api_key === "string" ? body.claude_api_key.trim() : "";

  if (!fmpKey && !claudeKey) {
    return new Response(JSON.stringify({ error: "Kein Key uebergeben." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Nur die tatsaechlich uebergebenen Felder werden verschluesselt und
  // geschrieben - ein leeres Feld laesst den bereits gespeicherten Key
  // (falls vorhanden) unangetastet, statt ihn zu loeschen. Klartext
  // existiert nur hier kurzzeitig im Speicher, wird nie geloggt oder in
  // die DB geschrieben.
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };

  if (fmpKey) {
    const { ciphertext, iv } = await encryptSecret(fmpKey);
    row.fmp_key_ciphertext = ciphertext;
    row.fmp_key_iv = iv;
    row.fmp_key_last4 = fmpKey.slice(-4);
  }
  if (claudeKey) {
    const { ciphertext, iv } = await encryptSecret(claudeKey);
    row.claude_key_ciphertext = ciphertext;
    row.claude_key_iv = iv;
    row.claude_key_last4 = claudeKey.slice(-4);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { error } = await adminClient.from("user_api_keys").upsert(row, { onConflict: "user_id" });
  if (error) {
    return new Response(JSON.stringify({ error: `Speichern fehlgeschlagen: ${error.message}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
