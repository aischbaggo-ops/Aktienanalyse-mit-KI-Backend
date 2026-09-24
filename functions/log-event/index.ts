import { corsHeaders } from "../_shared/cors.ts";
import { logAppEvent, type AppEventStatus } from "../_shared/appEvents.ts";

// Oeffentlicher Endpoint (KEIN Login noetig, verify_jwt=false wie analyse/
// symbol-search) - genau die "stillen" Fehlschlaege, die dieses Log sichtbar
// machen soll, passieren oft GENAU dann, wenn (noch) keine gueltige Session
// existiert (abgelaufener Passwort-setzen-Link, fehlgeschlagener Login) -
// siehe migrations/20260925090000_add_api_call_log_and_app_events.sql.
//
// Bewusst eng validiert (fester event_type-Allowlist, Status-Enum,
// Groessenlimit fuer details), damit dieser offene Endpoint nicht zum
// beliebigen Schreib-Ziel wird. user_id kommt NIE vom Client (waere nicht
// vertrauenswuerdig ohne gueltige Session) - bleibt fuer client-gemeldete
// Ereignisse immer null.
const ALLOWED_EVENT_TYPES = new Set([
  "password_set_invalid_link",
  "password_set_success",
  "password_set_failed",
  "login_failed",
]);
const ALLOWED_STATUS = new Set(["ok", "failed", "suspicious"]);
const MAX_DETAILS_CHARS = 2000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const eventType = (body.event_type ?? "").toString();
  const status = (body.status ?? "").toString();
  const details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : null;

  if (!ALLOWED_EVENT_TYPES.has(eventType) || !ALLOWED_STATUS.has(status)) {
    return new Response(JSON.stringify({ error: "Ungültiger event_type oder status." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (details && JSON.stringify(details).length > MAX_DETAILS_CHARS) {
    return new Response(JSON.stringify({ error: "details zu groß." }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await logAppEvent({
    eventType,
    functionName: "log-event",
    status: status as AppEventStatus,
    details,
  });

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
