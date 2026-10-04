// Audit M-Fund (urspruenglich Pentest-Scratchpad M2): Access-Control-Allow-
// Origin auf echte App-Origins eingeschraenkt statt "*". CORS schuetzt
// nur browserbasierte Cross-Origin-Requests (kein Ersatz fuer
// verifyUser()/RLS), aber "*" erlaubt jeder beliebigen Webseite, im Browser
// eines eingeloggten Nutzers per fetch/XHR direkt gegen diese Functions zu
// spielen - eine zusaetzliche Huerde, kein Allheilmittel.
//
// ALLOWED_ORIGIN wird als Secret gesetzt und darf kommagetrennt mehrere
// Origins enthalten, z.B.
//   npx supabase secrets set "ALLOWED_ORIGIN=https://aktienanalyse-mit-ki.vercel.app,http://localhost:5173"
// Eintraege werden getrimmt und EXAKT verglichen (kein Wildcard, kein
// Pattern). Steht die Request-Origin in der Liste, wird genau sie gespiegelt;
// sonst antwortet die Function mit dem ERSTEN Listeneintrag - der Browser
// blockt dann, weil der Header nicht zur Request-Origin passt. Vary: Origin
// ist auf jeder Antwort (auch Preflight) gesetzt, damit Caches die
// origin-abhaengige Antwort nicht fuer andere Origins ausliefern.
//
// Ohne gesetztes Secret (z.B. lokal mit "supabase functions serve") faellt es
// auf "*" zurueck, damit lokale Entwicklung ohne zusaetzliche Konfiguration
// funktioniert - das Secret MUSS im Live-Projekt gesetzt sein, sonst greift
// die Einschraenkung dort nicht.
//
// Vercel-Preview-URLs sind bewusst nicht enthalten; wird eine gebraucht,
// ihre konkrete URL voruebergehend ins Secret eintragen.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

// Pro Request aufrufen (die erlaubte Origin haengt vom Request ab).
export function corsFor(req: Request): Record<string, string> {
  let allow = "*";
  if (ALLOWED_ORIGINS.length > 0) {
    const origin = req.headers.get("Origin");
    allow = origin !== null && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}
