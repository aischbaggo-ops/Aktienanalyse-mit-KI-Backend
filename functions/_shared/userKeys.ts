import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptSecret } from "./crypto.ts";

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
