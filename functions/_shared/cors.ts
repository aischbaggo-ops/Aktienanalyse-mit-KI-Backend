// CORS-Allowlist (Variante A, Audit M-Fund / T-H1). CORS schuetzt nur
// browserbasierte Cross-Origin-Requests (kein Ersatz fuer verifyUser()/RLS),
// ist aber eine zusaetzliche Huerde gegen fremde Webseiten.
//
// ALLOWED_ORIGIN wird als Secret gesetzt und ist kommagetrennt, z.B.
//   npx supabase secrets set ALLOWED_ORIGIN="https://aktienanalyse-mit-ki.vercel.app,http://localhost:5173"
// Eintraege werden getrimmt, leere Eintraege verworfen. Der Request-Header
// Origin wird EXAKT verglichen (case-sensitiv, kein Wildcard, kein Pattern,
// kein Slash-Abgleich). Treffer: Access-Control-Allow-Origin = genau diese
// Origin. Kein Treffer, kein Origin-Header oder nicht gesetztes Secret: gar
// kein Access-Control-Allow-Origin-Header (der Browser blockt dann).
// Vary: Origin steht auf JEDER Antwort, auch bei Nicht-Treffer, damit Caches
// die origin-abhaengige Antwort nicht fuer andere Origins ausliefern.
//
// Vercel-Preview-URLs sind bewusst nicht enthalten; wird eine gebraucht,
// ihre konkrete URL voruebergehend ins Secret eintragen.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGIN") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

// Pro Request aufrufen (die erlaubte Origin haengt vom Request ab).
export function corsFor(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
  const origin = req.headers.get("Origin");
  if (origin !== null && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
