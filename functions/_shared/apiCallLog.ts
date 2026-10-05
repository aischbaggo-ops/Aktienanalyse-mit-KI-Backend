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
  // Nur bei LLM-Providern gesetzt (z.B. "end_turn", "max_tokens",
  // "tool_use") - Diagnose-Signal fuer abgeschnittene Antworten, siehe
  // migrations/20260928100000_add_stop_reason_to_api_call_log.sql.
  stopReason?: string | null;
  // Von der LLM-API gemeldetes Modell (raw.model), nur bei LLM-Calls. Spalte
  // api_call_log.model kommt per Migration
  // 20261005100000_add_model_to_api_call_log.sql.
  model?: string | null;
}

// PostgREST meldet eine unbekannte Spalte als PGRST204 (Schema-Cache) bzw.
// Postgres 42703 - dann fehlt nur die Migration, nicht der ganze Eintrag.
function isMissingColumnError(error: { code?: string } | null): boolean {
  return error?.code === "PGRST204" || error?.code === "42703";
}

// Granulares Tracking JEDES einzelnen FMP-/LLM-API-Calls (nicht nur
// aggregiert pro Analyse) - siehe
// migrations/20260925090000_add_api_call_log_and_app_events.sql. Schlaegt
// bewusst NIE in einer Weise fehl, die den eigentlichen Aufruf
// beeintraechtigt - ein Logging-Fehler darf nie eine Analyse abbrechen,
// daher hier ein eigenes try/catch statt den Fehler durchzureichen.
export async function logApiCall(entry: ApiCallLogEntry): Promise<void> {
  try {
    const row = {
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
      stop_reason: entry.stopReason ?? null,
    };
    if (entry.model == null) {
      await supabase.from("api_call_log").insert(row);
      return;
    }
    const { error } = await supabase.from("api_call_log").insert({ ...row, model: entry.model });
    if (isMissingColumnError(error)) {
      // Migration noch nicht eingespielt: ohne Modell erneut schreiben, damit
      // die uebrigen Felder nicht verloren gehen.
      await supabase.from("api_call_log").insert(row);
    }
  } catch (e) {
    console.error("[logApiCall] failed:", (e as Error).message);
  }
}
