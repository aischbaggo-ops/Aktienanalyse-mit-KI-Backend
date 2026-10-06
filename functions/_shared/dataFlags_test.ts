// Aufruf (aus dem Repo-Root): deno test functions/_shared/dataFlags_test.ts
// Rein lokal, ohne Netz und ohne DB.
import {
  BENCHMARK_SYMBOL,
  buildDataFlags,
  buildNewsSummary,
  classifyNewsStatus,
  reportedCurrencyFrom,
} from "./dataFlags.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

Deno.test("news_status: ok bei nicht leerem Array, empty bei leerem Array", () => {
  assert(classifyNewsStatus({ ok: true, data: [{ title: "x" }], status: 200 }) === "ok", "ok");
  assert(classifyNewsStatus({ ok: true, data: [], status: 200 }) === "empty", "empty");
});

Deno.test("news_status: blocked bei 401/402/403", () => {
  for (const status of [401, 402, 403]) {
    assert(classifyNewsStatus({ ok: false, data: { message: "x" }, status }) === "blocked", `HTTP ${status}`);
  }
});

Deno.test("news_status: blocked bei Klartext-Antwort (Nicht-JSON), unabhaengig vom Status", () => {
  const restricted = { ok: false, error: "Unexpected token 'R'", status: 200, bodySnippet: "Restricted Endpoint" };
  const premium = { ok: false, error: "Unexpected token 'P'", status: null, bodySnippet: "Premium Query Parameter" };
  assert(classifyNewsStatus(restricted) === "blocked", "Restricted");
  assert(classifyNewsStatus(premium) === "blocked", "Premium");
});

Deno.test("news_status: blocked bei JSON-Fehlertext mit Zugriffshinweis", () => {
  const r = { ok: true, data: { "Error Message": "Restricted Endpoint - upgrade your plan" }, status: 200 };
  assert(classifyNewsStatus(r) === "blocked", "Error Message");
});

Deno.test("news_status: error bei 429, 5xx, Netzwerkfehler, unbekanntem Klartext", () => {
  assert(classifyNewsStatus({ ok: false, data: { message: "Limit Reach" }, status: 429 }) === "error", "429");
  assert(classifyNewsStatus({ ok: false, data: {}, status: 500 }) === "error", "500");
  assert(classifyNewsStatus({ ok: false, error: "fetch failed", status: null }) === "error", "Netzwerk");
  assert(classifyNewsStatus({ ok: false, error: "x", status: 200, bodySnippet: "<html>Bad gateway</html>" }) === "error", "HTML");
  assert(classifyNewsStatus(undefined) === "error", "undefined");
});

Deno.test("News-Block im Prompt: neutral, ohne Planname, zustandsabhaengig", () => {
  const items = [{ publishedDate: "2026-10-01", title: "Titel A" }, { date: "2026-09-30", text: "Text B" }];
  assert(buildNewsSummary(items, "ok") === "- [2026-10-01] Titel A\n- [2026-09-30] Text B", "Liste");
  assert(buildNewsSummary([], "empty") === "Keine aktuellen News gefunden.", "empty");
  assert(buildNewsSummary([], "blocked") === "News für diesen Lauf nicht abrufbar.", "blocked");
  assert(buildNewsSummary([], "error") === "News für diesen Lauf nicht abrufbar.", "error");
  assert(buildNewsSummary([], undefined) === "News für diesen Lauf nicht abrufbar.", "unbekannt");
  for (const s of ["empty", "blocked", "error"] as const) {
    assert(!/plan|free|premium/i.test(buildNewsSummary([], s)), `kein Planname bei ${s}`);
  }
});

Deno.test("reported_currency: Bilanz zuerst, GuV als Ersatz, sonst null", () => {
  assert(reportedCurrencyFrom([{ reportedCurrency: "EUR" }], [{ reportedCurrency: "USD" }]) === "EUR", "Bilanz");
  assert(reportedCurrencyFrom([], [{ reportedCurrency: "CHF" }]) === "CHF", "GuV");
  assert(reportedCurrencyFrom([{ date: "2025" }], [{}]) === null, "null");
  assert(reportedCurrencyFrom([{ reportedCurrency: "USD" }, { reportedCurrency: "EUR" }], []) === "EUR", "juengste Zeile");
});

Deno.test("data_flags: Felder aus dataAvailability uebernommen", () => {
  const f = buildDataFlags({
    newsStatus: "blocked",
    availability: { news: 0, priceStock: 6000, estimates: 4 },
    balanceRows: [{ reportedCurrency: "USD" }],
    incomeRows: [],
  });
  assert(f.news_status === "blocked" && f.news_count === 0, "news");
  assert(f.price_points === 6000 && f.estimates_count === 4, "Zaehler");
  assert(f.reported_currency === "USD", "Waehrung");
  assert(f.benchmark_symbol === "^GSPC" && BENCHMARK_SYMBOL === "^GSPC", "Benchmark");
  assert(encodeURIComponent(BENCHMARK_SYMBOL) === "%5EGSPC", "URL unveraendert");
});
