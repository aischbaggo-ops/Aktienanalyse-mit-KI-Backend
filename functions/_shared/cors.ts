// Pentest-Scratchpad M2: Access-Control-Allow-Origin auf die echte
// App-Domain eingeschraenkt statt "*". CORS schuetzt nur browserbasierte
// Cross-Origin-Requests (kein Ersatz fuer verifyUser()/RLS), aber "*"
// erlaubt jeder beliebigen Webseite, im Browser eines eingeloggten Nutzers
// per fetch/XHR direkt gegen diese Functions zu spielen - eine zusaetzliche
// Huerde, kein Allheilmittel.
//
// ALLOWED_ORIGIN wird als Secret gesetzt (npx supabase secrets set
// ALLOWED_ORIGIN=https://aktienanalyse-mit-ki.vercel.app). Ohne gesetztes
// Secret (z.B. lokal mit "supabase functions serve") faellt es auf "*"
// zurueck, damit lokale Entwicklung ohne zusaetzliche Konfiguration
// funktioniert - das Secret MUSS im Live-Projekt gesetzt sein, sonst greift
// die Einschraenkung dort nicht.
//
// Deckt nur die Produktions-Domain ab, keine Vercel-Preview-URLs
// (*.vercel.app pro Branch/PR) - falls die je gegen das Live-Supabase-
// Projekt getestet werden sollen, muesste ALLOWED_ORIGIN entsprechend
// erweitert werden (z.B. kommagetrennt + Split hier).
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";

export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
