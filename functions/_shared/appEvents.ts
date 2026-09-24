import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export type AppEventStatus = "ok" | "failed" | "suspicious";

// Allgemeines Ereignis-Log fuer "stille" Fehlschlaege (HTTP-technisch
// erfolgreich, aber das eigentliche Ziel nicht erreicht) und
// sicherheitsrelevante Auffaelligkeiten - siehe
// migrations/20260925090000_add_api_call_log_and_app_events.sql. Kurze
// Aufbewahrung (7 Tage, per pg_cron bereinigt), reine akute Fehlersuche,
// kein Langzeit-Audit-Log. Schlaegt wie logApiCall() bewusst nie in einer
// Weise fehl, die den eigentlichen Vorgang beeintraechtigt.
export async function logAppEvent(params: {
  eventType: string;
  functionName: string;
  status: AppEventStatus;
  userId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await supabase.from("app_events").insert({
      event_type: params.eventType,
      function_name: params.functionName,
      status: params.status,
      user_id: params.userId ?? null,
      details: params.details ?? null,
    });
  } catch (e) {
    console.error("[logAppEvent] failed:", (e as Error).message);
  }
}
