import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { requireAdmin } from "../_shared/adminGate.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";

// Genehmigt eine Zugangsanfrage (access_requests) und loest direkt die
// Konto-Einladung aus - ersetzt den bisherigen manuellen Schritt "Admin
// legt den Nutzer haendisch in Supabase an". Nur Admins, per verifyUser()
// + requireAdmin() wie die anderen Admin-Functions.
//
// Nutzt das separate email-Feld (nicht contact - das bleibt bewusst ein
// freier Kontaktweg, siehe accessRequest.ts im Frontend). Die Insert-RLS-
// Policy erzwingt email bei NEUEN Anfragen bereits als gueltige Adresse,
// Alt-Anfragen (vor Einfuehrung des Felds, Migration 20260923100000) haben
// aber email = null. Die Format-Pruefung hier bleibt deshalb als
// Absicherung bestehen (Status bleibt "neu", klare Fehlermeldung) - sie
// sollte fuer neue Anfragen nie mehr greifen, faengt aber genau diesen
// Alt-Anfragen-Fall sauber ab statt Supabase mit ungueltiger Eingabe zu
// belasten oder den Status faelschlich auf "erledigt" zu setzen.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(req);
  if ("error" in auth) return json({ error: auth.error }, auth.status);

  const admin = await requireAdmin(auth.userId);
  if (!admin.ok) return json({ error: admin.error }, admin.status);

  const body = await req.json().catch(() => ({}));
  const requestId = (body.request_id ?? "").toString().trim();
  if (!requestId) return json({ error: "request_id fehlt im Request-Body" }, 400);

  const { data: request, error: loadError } = await supabase
    .from("access_requests")
    .select("id, email, status")
    .eq("id", requestId)
    .maybeSingle();

  if (loadError) return json({ error: loadError.message }, 500);
  if (!request) return json({ error: "Zugangsanfrage nicht gefunden." }, 404);
  // Verhindert eine doppelte Einladung, falls z.B. zwei Admin-Tabs offen
  // sind oder der Button doppelt geklickt wird.
  if (request.status !== "neu") {
    return json({ error: `Anfrage ist bereits "${request.status}", keine erneute Einladung.` }, 409);
  }

  const email = (request.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return json(
      { error: `Diese Anfrage hat keine gültige E-Mail-Adresse hinterlegt (Alt-Anfrage?) - bitte manuell in Supabase einladen.` },
      400,
    );
  }

  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email);
  if (inviteError) {
    await logFunctionError("approve-access-request", auth.userId, `inviteUserByEmail(${email}): ${inviteError.message}`);
    return json({ error: `Einladung fehlgeschlagen: ${inviteError.message}` }, 500);
  }

  const invitedAt = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("access_requests")
    .update({ status: "erledigt", invited_at: invitedAt })
    .eq("id", requestId);

  if (updateError) {
    // Die Einladungsmail ist zu diesem Zeitpunkt bereits raus - ein
    // fehlgeschlagenes Status-Update darf das nicht verschweigen (sonst
    // klickt der Admin ggf. nochmal und es geht eine zweite Mail raus).
    await logFunctionError(
      "approve-access-request",
      auth.userId,
      `Einladung an ${email} verschickt, aber Status-Update fehlgeschlagen: ${updateError.message}`,
    );
    return json(
      { error: `Einladung wurde verschickt, aber der Status konnte nicht aktualisiert werden: ${updateError.message}` },
      500,
    );
  }

  return json({ ok: true, invited_at: invitedAt });
});
