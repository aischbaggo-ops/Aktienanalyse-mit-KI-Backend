// Aufruf (aus dem Repo-Root): deno test functions/_shared/news_test.ts
// Rein lokal, ohne Netz und ohne DB.
import { buildDataFlags, classifyNewsStatus, type FmpResultLike } from "./dataFlags.ts";
import { fetchNews } from "./news.ts";
import { arr } from "./scoring.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Formen des Ergebnisses von fmpGet() (analyse/index.ts) fuer den News-Endpunkt.
const CASES: Record<string, FmpResultLike & { authError?: boolean }> = {
  "ok": { ok: true, data: [{ title: "a" }, { title: "b" }], authError: false, status: 200 },
  "empty": { ok: true, data: [], authError: false, status: 200 },
  "403 mit JSON-Body": { ok: false, data: { "Error Message": "Forbidden" }, authError: true, status: 403 },
  "402": { ok: false, data: { message: "Premium" }, authError: false, status: 402 },
  "429": { ok: false, data: { message: "Limit" }, authError: false, status: 429 },
  "503": { ok: false, data: {}, authError: false, status: 503 },
  "Klartext Restricted": { ok: false, error: "Unexpected token", authError: false, status: 200, bodySnippet: "Restricted Endpoint" },
  "Netzwerkfehler": { ok: false, error: "fetch failed", authError: false, status: null },
};

Deno.test("fetchNews: derselbe FMP-Pfad wie bisher", async () => {
  let path = "";
  await fetchNews("AAPL", (p) => {
    path = p;
    return Promise.resolve(CASES["ok"]);
  });
  assert(path === "/news/stock?symbols=AAPL&limit=20", `Pfad war ${path}`);
});

Deno.test("fetchNews: Status und Quelle fuer ok, empty, blocked, error", async () => {
  const expected: Record<string, string> = {
    "ok": "ok",
    "empty": "empty",
    "403 mit JSON-Body": "blocked",
    "402": "blocked",
    "429": "error",
    "503": "error",
    "Klartext Restricted": "blocked",
    "Netzwerkfehler": "error",
  };
  for (const [name, res] of Object.entries(CASES)) {
    const r = await fetchNews("X", () => Promise.resolve(res));
    assert(r.status === expected[name], `${name}: Status ${r.status}`);
    assert(r.source === "fmp", `${name}: Quelle`);
  }
});

Deno.test("fetchNews: Status identisch zu classifyNewsStatus auf dem rohen Ergebnis", async () => {
  for (const [name, res] of Object.entries(CASES)) {
    const r = await fetchNews("X", () => Promise.resolve(res));
    assert(r.status === classifyNewsStatus(res), name);
  }
});

Deno.test("fetchNews: items entsprechen dem, was computeScores bisher per arr() bekam", async () => {
  for (const [name, res] of Object.entries(CASES)) {
    const r = await fetchNews("X", () => Promise.resolve(res));
    const legacy = arr(res);
    const viaSeam = arr({ ok: true, data: r.items });
    assert(JSON.stringify(viaSeam) === JSON.stringify(legacy), `${name}: ${JSON.stringify(viaSeam)} vs ${JSON.stringify(legacy)}`);
  }
});

Deno.test("data_flags.news_source: Standard fmp, uebernimmt die Quelle des Laufs", () => {
  const base = {
    newsStatus: "ok" as const,
    availability: { news: 2, priceStock: 5000, estimates: 4 },
    balanceRows: [],
    incomeRows: [],
  };
  assert(buildDataFlags(base).news_source === "fmp", "Standard fmp");
  assert(buildDataFlags({ ...base, newsSource: "fmp" }).news_source === "fmp", "durchgereicht");
});
