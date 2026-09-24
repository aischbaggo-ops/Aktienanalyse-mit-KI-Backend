import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret } from "./crypto.ts";
import { LLM_PROVIDERS, type LlmProvider } from "./llm/types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export interface UserApiKeys {
  fmpKey: string | null;
  claudeKey: string | null;
}

// Laedt und entschluesselt die eigenen FMP-/Claude-Keys des verifizierten
// Nutzers. Service-Role-Client (RLS-Bypass) ist hier unproblematisch, da
// die userId bereits per verifyUser() aus dem Token stammt, nicht aus
// einem Client-Feld.
export async function loadUserApiKeys(userId: string): Promise<UserApiKeys> {
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await adminClient
    .from("user_api_keys")
    .select("fmp_key_ciphertext, fmp_key_iv, claude_key_ciphertext, claude_key_iv")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return { fmpKey: null, claudeKey: null };

  const fmpKey =
    data.fmp_key_ciphertext && data.fmp_key_iv
      ? await decryptSecret(data.fmp_key_ciphertext, data.fmp_key_iv)
      : null;
  const claudeKey =
    data.claude_key_ciphertext && data.claude_key_iv
      ? await decryptSecret(data.claude_key_ciphertext, data.claude_key_iv)
      : null;

  return { fmpKey, claudeKey };
}

export interface ActiveLlmKey {
  provider: LlmProvider;
  apiKey: string | null;
  model: string | null;
}

// Laedt den aktiven LLM-Anbieter des Nutzers (profiles.active_llm_provider,
// Default 'claude' fuer Zeilen ohne explizite Einstellung - siehe Migration
// 20260924100000) sowie dessen entschluesselten Key/Modellnamen aus
// user_llm_keys. apiKey/model sind null, wenn fuer den aktiven Anbieter noch
// kein Key hinterlegt wurde - der Aufrufer (analyse/index.ts) entscheidet,
// wie er das meldet (analog zum bisherigen "Bitte hinterlege deinen Key"-
// Verhalten).
export async function loadActiveLlmKey(userId: string): Promise<ActiveLlmKey> {
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profileRow } = await adminClient
    .from("profiles")
    .select("active_llm_provider")
    .eq("id", userId)
    .maybeSingle();
  const rawProvider = profileRow?.active_llm_provider;
  // Defensive Validierung - die DB-CHECK-Constraint (Migration 20260924100000)
  // sollte das schon garantieren, aber ein unerwarteter Wert soll hier lieber
  // sauber auf 'claude' zurueckfallen als spaeter mit einem falschen Provider-
  // Typ durchrutschen.
  const provider: LlmProvider = LLM_PROVIDERS.includes(rawProvider as LlmProvider) ? (rawProvider as LlmProvider) : "claude";

  const { data: keyRow } = await adminClient
    .from("user_llm_keys")
    .select("key_ciphertext, key_iv, model")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();

  if (!keyRow) return { provider, apiKey: null, model: null };

  const apiKey = await decryptSecret(keyRow.key_ciphertext, keyRow.key_iv);
  return { provider, apiKey, model: keyRow.model ?? null };
}
