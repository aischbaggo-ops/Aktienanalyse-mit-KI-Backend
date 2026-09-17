import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
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

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Kein Authorization-Token uebergeben." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // SICHERHEITSKRITISCH: Anon-Key-Client NUR zur Token-Validierung -
  // liefert den Nutzer, dem DIESER Token tatsaechlich gehoert, unabhaengig
  // davon, was der Client sonst im Request behauptet. Anders als
  // analyse/symbol-search (die einer vom Client mitgeschickten user_id im
  // Body vertrauen - dort tolerierbar, hier nicht) wird fuer eine
  // Konto-Loeschung NIE eine user_id aus dem Body verwendet. Ohne diese
  // Pruefung koennte jeder durch simples Aendern eines Body-Felds ein
  // fremdes Konto loeschen.
  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return new Response(JSON.stringify({ error: "Ungueltiger oder abgelaufener Token." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;

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
    return new Response(
      JSON.stringify({ error: `Watchlist konnte nicht geloescht werden: ${watchlistsError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { error: requestLogError } = await adminClient.from("request_log").delete().eq("user_id", userId);
  if (requestLogError) {
    return new Response(
      JSON.stringify({ error: `Anfrage-Verlauf konnte nicht geloescht werden: ${requestLogError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { error: profileError } = await adminClient.from("profiles").delete().eq("id", userId);
  if (profileError) {
    return new Response(
      JSON.stringify({ error: `Profil konnte nicht geloescht werden: ${profileError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    return new Response(
      JSON.stringify({ error: `Konto konnte nicht geloescht werden: ${deleteUserError.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
