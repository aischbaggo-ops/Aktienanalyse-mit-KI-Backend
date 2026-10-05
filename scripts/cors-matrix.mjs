// CORS-Matrix (T-H1, Variante A): alle Edge Functions x 3 Origins x
// (OPTIONS-Preflight, GET). Aufruf aus dem Repo-Root (Repo-Root):
//   $env:SUPABASE_ANON_KEY = "<anon key>"; node scripts/cors-matrix.mjs
// Optional: SUPABASE_URL (Default: Projekt aus config.toml).
//
// Der Key kommt nur aus der Umgebung und wird nie ausgegeben. Es werden keine
// Daten veraendert: der Nicht-OPTIONS-Aufruf ist ein GET ohne Body. 11 der
// 12 Functions antworten darauf mit 405 (Methodenpruefung vor allem anderen),
// symbol-search mit 401 (verifyUser, kein User-Token).
import { readdirSync, readFileSync, existsSync } from "node:fs";

const BASE = (process.env.SUPABASE_URL ?? "https://lthzvefqwhyiynescyhq.supabase.co").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_ANON_KEY ?? "";

const APP = "https://aktienanalyse-mit-ki.vercel.app";
const ORIGINS = [
  { origin: APP, allowed: true },
  { origin: "http://localhost:5173", allowed: true },
  { origin: "https://evil.example", allowed: false },
];
const EXTRA = [
  { label: "Slash am Ende", origin: APP + "/" },
  { label: "Grossschreibung", origin: "HTTPS://AKTIENANALYSE-MIT-KI.VERCEL.APP" },
];
const EXTRA_FUNCTION = "analyse";

const functions = readdirSync("functions", { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(`functions/${d.name}/index.ts`))
  .map((d) => d.name)
  .sort();

async function call(fn, method, origin) {
  const headers = { Origin: origin };
  if (method === "OPTIONS") {
    headers["Access-Control-Request-Method"] = "POST";
    headers["Access-Control-Request-Headers"] = "authorization, content-type";
  } else if (KEY) {
    headers["apikey"] = KEY;
    headers["Authorization"] = `Bearer ${KEY}`;
  }
  const res = await fetch(`${BASE}/functions/v1/${fn}`, { method, headers });
  await res.arrayBuffer().catch(() => {});
  return {
    status: res.status,
    acao: res.headers.get("access-control-allow-origin"),
    vary: res.headers.get("vary"),
  };
}

const varyHasOrigin = (v) => (v ?? "").split(",").some((t) => t.trim().toLowerCase() === "origin");

function evaluate({ allowed }, method, r, origin) {
  const problems = [];
  if (allowed) {
    if (r.acao !== origin) problems.push("ACAO != Origin");
    if (method === "OPTIONS" && r.status !== 204) problems.push("Preflight != 204");
  } else if (r.acao !== null) {
    problems.push("ACAO gesetzt");
  }
  if (r.acao === "*") problems.push("ACAO = *");
  if (!varyHasOrigin(r.vary)) problems.push("Vary ohne Origin");
  return problems;
}

const rows = [];
function record(fn, origin, method, r, problems) {
  rows.push({ fn, origin, method, status: r.status, acao: r.acao ?? "(fehlt)", vary: r.vary ?? "(fehlt)", problems });
}

console.log(`Ziel: ${BASE}  |  Functions: ${functions.length}  |  Key gesetzt: ${KEY ? "ja" : "nein"}`);
console.log(`Functions: ${functions.join(", ")}`);
console.log("Nicht-OPTIONS-Aufruf: GET ohne Body (veraendert keine Daten)\n");

for (const fn of functions) {
  for (const o of ORIGINS) {
    for (const method of ["OPTIONS", "GET"]) {
      try {
        const r = await call(fn, method, o.origin);
        record(fn, o.origin, method, r, evaluate(o, method, r, o.origin));
      } catch (e) {
        record(fn, o.origin, method, { status: "ERR", acao: null, vary: null }, [`Fehler: ${e.message}`]);
      }
    }
  }
}
for (const x of EXTRA) {
  try {
    const r = await call(EXTRA_FUNCTION, "OPTIONS", x.origin);
    const problems = [];
    if (r.acao !== null) problems.push("ACAO gesetzt");
    if (!varyHasOrigin(r.vary)) problems.push("Vary ohne Origin");
    record(`${EXTRA_FUNCTION} [${x.label}]`, x.origin, "OPTIONS", r, problems);
  } catch (e) {
    record(`${EXTRA_FUNCTION} [${x.label}]`, x.origin, "OPTIONS", { status: "ERR", acao: null, vary: null }, [`Fehler: ${e.message}`]);
  }
}

const pad = (s, n) => String(s).padEnd(n);
const w = {
  fn: Math.max(8, ...rows.map((r) => r.fn.length)),
  origin: Math.max(6, ...rows.map((r) => r.origin.length)),
};
console.log(
  [pad("Function", w.fn), pad("Origin", w.origin), pad("Meth", 7), pad("HTTP", 5), pad("ACAO", w.origin), pad("Vary", 12), "Ergebnis"].join("  "),
);
for (const r of rows) {
  console.log(
    [
      pad(r.fn, w.fn),
      pad(r.origin, w.origin),
      pad(r.method, 7),
      pad(r.status, 5),
      pad(r.acao, w.origin),
      pad(r.vary, 12),
      r.problems.length === 0 ? "OK" : `FAIL (${r.problems.join("; ")})`,
    ].join("  "),
  );
}

const ok = rows.filter((r) => r.problems.length === 0).length;
console.log(`\n${ok} von ${rows.length} OK`);
process.exit(ok === rows.length ? 0 : 1);
