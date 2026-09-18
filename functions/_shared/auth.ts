import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export type VerifyUserResult = { userId: string } | { error: string; status: number };

// Verifiziert den Authorization-Bearer-Token serverseitig und liefert die
// echte, zugehoerige User-ID - niemals eine vom Client behauptete user_id
// aus dem Body vertrauen. Einheitliches Muster fuer alle Functions, die
// wissen muessen, WER genau den Request stellt (delete-account, analyse,
// symbol-search, save-api-keys). Der Anon-Key-Client wird NUR zur
// Token-Validierung verwendet, nie fuer eigentliche Datenzugriffe.
export async function verifyUser(req: Request): Promise<VerifyUserResult> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { error: "Kein Authorization-Token uebergeben.", status: 401 };
  }
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) {
    return { error: "Ungueltiger oder abgelaufener Token.", status: 401 };
  }
  return { userId: data.user.id };
}
