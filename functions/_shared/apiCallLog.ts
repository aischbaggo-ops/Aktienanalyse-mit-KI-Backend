import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

export interface ApiCallLogEntry {
  functionName: string;
  provider: string;
  callType?: string | null;
  ticker?: string | null;
  success: boolean;
  durationMs: number;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  costUsd?: number | null;
  errorMessage?: string | null;
}

// Granulares Tracking JEDES einzelnen FMP-/LLM-API-Calls (nicht nur
// aggregiert pro Analyse) - siehe
// migrations/20260925090000_add_api_call_log_and_app_events.sql. Schlaegt
// bewusst NIE in einer Weise fehl, die den eigentlichen Aufruf
// beeintraechtigt - ein Logging-Fehler darf nie eine Analyse abbrechen,
// daher hier ein eigenes try/catch statt den Fehler durchzureichen.
export async function logApiCall(entry: ApiCallLogEntry): Promise<void> {
  try {
    await supabase.from("api_call_log").insert({
      function_name: entry.functionName,
      provider: entry.provider,
      call_type: entry.callType ?? null,
      ticker: entry.ticker ?? null,
      success: entry.success,
      duration_ms: Math.round(entry.durationMs),
      tokens_input: entry.tokensInput ?? null,
      tokens_output: entry.tokensOutput ?? null,
      cost_usd: entry.costUsd ?? null,
      error_message: entry.errorMessage ?? null,
    });
  } catch (e) {
    console.error("[logApiCall] failed:", (e as Error).message);
  }
}
