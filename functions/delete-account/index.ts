import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser } from "../_shared/auth.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // SICHERHEITSKRITISCH: verifyUser() liefert den Nutzer, dem der Token
  // tatsaechlich gehoert, unabhaengig davon, was der Client sonst im
  // Request behauptet. Fuer eine Konto-Loeschung wird NIE eine user_id aus
  // dem Body verwendet. Ohne diese Pruefung koennte jeder durch simples
  // Aendern eines Body-Felds ein fremdes Konto loeschen.
  const auth = await verifyUser(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = auth.userId;

  // Ab hier ausschliesslich mit der verifizierten userId arbeiten. Der
  // Service-Role-Client wird nur noch fuer die eigentlichen Loesch-
  // operationen gebraucht (RLS-Bypass fuer request_log/profiles, die keine
  // eigene DELETE-Policy fuer Nutzer haben, sowie die Admin-API) - nicht
  // erneut zur Identitaetsbestimmung.
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Reihenfolge: abhaengige Nutzerdaten zuerst, Auth-Eintrag zuletzt - bei
  // einem Fehler mitten drin bleibt der Auth-User bestehen (kein Konto
  // verschwindet, waehrend noch Datenreste existieren, ohne dass das
  // gemeldet wird). stock_analyses (geteilter Cache) bleibt in jedem Fall
  // unangetastet - keine FK-Beziehung zu Nutzerdaten. search_log wird
  // bewusst nicht angefasst: die Tabelle hat keine user_id-Spalte, die
  // Suchanfragen sind bereits vollstaendig anonym.
  const { error: watchlistsError } = await adminClient.from("watchlists").delete().eq("user_id", userId);
  if (watchlistsError) {
    await logFunctionError("delete-account", userId, `Watchlist: ${watchlistsError.message}`);
    return new Response(
      JSON.stringify({ error: `Watchlist konnte nicht geloescht werden: ${watchlistsError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { error: requestLogError } = await adminClient.from("request_log").delete().eq("user_id", userId);
  if (requestLogError) {
    await logFunctionError("delete-account", userId, `Anfrage-Verlauf: ${requestLogError.message}`);
    return new Response(
      JSON.stringify({ error: `Anfrage-Verlauf konnte nicht geloescht werden: ${requestLogError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Neu seit den eigenen API-Keys: verschluesselte FMP-/Claude-Key-Zeile
  // ebenfalls entfernen, sonst blieben Ciphertext-Reste ohne Bezug zu einem
  // existierenden Konto zurueck.
  const { error: apiKeysError } = await adminClient.from("user_api_keys").delete().eq("user_id", userId);
  if (apiKeysError) {
    await logFunctionError("delete-account", userId, `API-Keys: ${apiKeysError.message}`);
    return new Response(
      JSON.stringify({ error: `API-Keys konnten nicht geloescht werden: ${apiKeysError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { error: profileError } = await adminClient.from("profiles").delete().eq("id", userId);
  if (profileError) {
    await logFunctionError("delete-account", userId, `Profil: ${profileError.message}`);
    return new Response(
      JSON.stringify({ error: `Profil konnte nicht geloescht werden: ${profileError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    await logFunctionError("delete-account", userId, `Auth-User: ${deleteUserError.message}`);
    return new Response(
      JSON.stringify({ error: `Konto konnte nicht geloescht werden: ${deleteUserError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
