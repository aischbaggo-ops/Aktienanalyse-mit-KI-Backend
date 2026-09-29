import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// x-forwarded-for kann bei Proxy-Ketten mehrere, kommagetrennte IPs
// enthalten (Client zuerst) - siehe MDN. "unknown" als Fallback fasst alle
// Aufrufe ohne erkennbare IP in einen gemeinsamen Bucket statt sie
// ungebremst durchzulassen.
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

// Grosszuegiges IP-Rate-Limit fuer Endpoints ohne Auth-Check (aktuell nur
// log-event) - siehe migrations/20260927170000_add_log_event_rate_limit.sql
// fuer den atomaren Check-and-Increment in der DB. Faellt bei DB-Fehlern
// bewusst offen (true) - ein kurzzeitiger DB-Ausfall soll echtes Logging
// nicht blockieren, das Limit ist Rausch-/Flooding-Schutz, keine harte
// Sicherheitsgrenze.
export async function checkIpRateLimit(req: Request, limit = 30): Promise<boolean> {
  const ip = getClientIp(req);
  try {
    const { data, error } = await supabase.rpc("check_log_event_rate_limit", {
      p_ip: ip,
      p_limit: limit,
    });
    if (error) throw error;
    return data !== false;
  } catch (e) {
    console.error("[checkIpRateLimit] failed, failing open:", (e as Error).message);
    return true;
  }
}

// Grosszuegiges User-Rate-Limit fuer Endpoints MIT Auth-Check (analyse,
// symbol-search, admin-chat) - siehe
// migrations/20260928092000_add_user_rate_limit.sql fuer den atomaren
// Check-and-Increment in der DB (Stunden-Buckets, eine Tabelle/Funktion fuer
// alle drei ueber die "scope"-Spalte statt einer separaten Kopie je
// Function). Faellt wie checkIpRateLimit() bei DB-Fehlern bewusst offen -
// das Limit schuetzt vor versehentlichem/absichtlichem Ueberlasten des
// eigenen FMP-/Claude-Kontingents, ist keine harte Sicherheitsgrenze.
export async function checkUserRateLimit(userId: string, scope: string, limit: number): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("check_user_rate_limit", {
      p_user_id: userId,
      p_scope: scope,
      p_limit: limit,
    });
    if (error) throw error;
    return data !== false;
  } catch (e) {
    console.error(`[checkUserRateLimit] scope=${scope} failed, failing open:`, (e as Error).message);
    return true;
  }
}
