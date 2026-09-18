import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Eigener Service-Role-Client statt des Anon-Clients aus verifyUser() -
// bewusst getrennt von auth.ts, das ausschliesslich Token-Validierung macht
// und nie einen Service-Role-Client haelt.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export type RequireAdminResult = { ok: true } | { ok: false; error: string; status: number };

// Serverseitiges Admin-Gate. Frontend-Routing-Guard und RLS-Policies
// schuetzen nur die UI bzw. Tabellen-Zugriffe - eine Edge Function selbst
// ist ohne diesen Check fuer JEDEN eingeloggten Nutzer aufrufbar, der die
// URL kennt. Fuer kostenpflichtige Admin-Functions (z.B. admin-chat) MUSS
// das hier VOR jedem Claude-/Web-Search-Call passieren, sonst kann jeder
// authentifizierte Nutzer Kosten verursachen.
export async function requireAdmin(userId: string): Promise<RequireAdminResult> {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    return { ok: false, error: `Admin-Pruefung fehlgeschlagen: ${error.message}`, status: 500 };
  }
  if (!data?.is_admin) {
    return { ok: false, error: "Kein Admin-Zugriff.", status: 403 };
  }
  return { ok: true };
}
