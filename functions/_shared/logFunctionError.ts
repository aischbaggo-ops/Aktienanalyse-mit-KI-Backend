import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Eigener, minimaler Client statt einen vom Aufrufer uebergebenen adminClient
// vorauszusetzen - so ist logFunctionError() unabhaengig einsetzbar, auch an
// Fehler-Stellen, die vor Anlage eines lokalen Clients liegen.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Schreibt einen Eintrag in function_errors fuer Edge Functions ohne
// Ticker-Bezug (save-api-keys, delete-account). Darf den eigentlichen
// Fehler-Response an den Client nie verhindern oder verzoegern - ein Fehler
// beim Loggen selbst wird nur serverseitig per console.error sichtbar, nie
// durchgereicht oder erneut geworfen.
export async function logFunctionError(functionName: string, userId: string | null, errorMessage: string) {
  try {
    const { error } = await supabase.from("function_errors").insert({
      function_name: functionName,
      user_id: userId,
      error_message: errorMessage,
    });
    if (error) {
      console.error(`[logFunctionError] insert failed for ${functionName}:`, error.message);
    }
  } catch (e) {
    console.error(`[logFunctionError] unexpected failure for ${functionName}:`, e);
  }
}
