// Aufruf (aus dem Repo-Root): deno test functions/_shared/fmpStatus_test.ts
// Rein lokal, ohne Netz.
import { AnalysisAbort, classifyFmpResult, preLlmAbort, profileAbort, rateLimitAbort } from "./fmpStatus.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const okRows = { ok: true, data: [{ symbol: "AAPL" }], status: 200 };
const empty = { ok: true, data: [], status: 200 };
const http = (status: number, data: unknown = { "Error Message": "x" }) => ({ ok: false, data, status });
const premium200 = { ok: true, data: { "Error Message": "Premium Query Parameter: 'symbol'" }, status: 200 };

Deno.test("Statusklassen: 404/leer, 402, 429, 5xx, 401/403, Netz", () => {
  assert(classifyFmpResult(okRows) === "ok", "ok");
  assert(classifyFmpResult(empty) === "empty", "leer");
  assert(classifyFmpResult(http(404)) === "not_found", "404");
  assert(classifyFmpResult(http(402)) === "plan", "402");
  assert(classifyFmpResult(premium200) === "plan", "Premium-Text bei 200");
  assert(classifyFmpResult(http(429)) === "rate_limit", "429");
  assert(classifyFmpResult({ ok: true, data: { "Error Message": "Limit Reach . Please upgrade" }, status: 200 }) === "rate_limit", "Limit-Text");
  assert(classifyFmpResult(http(500)) === "outage", "500");
  assert(classifyFmpResult(http(503)) === "outage", "503");
  assert(classifyFmpResult(http(401)) === "auth", "401");
  assert(classifyFmpResult({ ok: false, error: "fetch failed", status: null }) === "network", "Netz");
});

Deno.test("Profil: leeres Profil und 404 = unbekannt, 429 nicht mehr 'existiert nicht'", () => {
  assert(profileAbort(okRows) === null, "Profil da");
  assert(profileAbort(empty)?.code === "fmp_not_found", "leer");
  assert(profileAbort(http(404))?.code === "fmp_not_found", "404");
  const rl = profileAbort(http(429));
  assert(rl?.code === "fmp_rate_limit", "429 -> Rate-Limit");
  assert(!rl?.message.includes("existiert"), rl?.message ?? "");
  assert(profileAbort(http(402))?.code === "fmp_plan", "402 -> Plan");
  assert(profileAbort(http(502))?.code === "fmp_outage", "502 -> Stoerung");
  assert(profileAbort(http(429)) instanceof AnalysisAbort, "AnalysisAbort");
});

Deno.test("Rate-Limit in irgendeinem Aufruf (ausser News) bricht den Lauf ab", () => {
  assert(rateLimitAbort({ profile: okRows, income: okRows }) === null, "kein 429");
  assert(rateLimitAbort({ profile: okRows, priceStockNew: http(429) })?.code === "fmp_rate_limit", "429 im Kursfenster");
  assert(rateLimitAbort({ profile: okRows, news: http(429) }) === null, "News zaehlen nicht");
});

const scoresAll = { fundamental: 70, krise: 60, trend: 55 };

Deno.test("LLM-Aufruf wird uebersprungen, wenn Fundamental, Krise oder Trend fehlt", () => {
  const ok = preLlmAbort({ scores: scoresAll, fundamentalResults: [okRows], stockPriceResults: [okRows, okRows] });
  assert(ok === null, "alles da -> LLM wird aufgerufen");

  const plan = preLlmAbort({
    scores: { ...scoresAll, krise: null, trend: null },
    fundamentalResults: [okRows],
    stockPriceResults: [http(402), http(402)],
  });
  assert(plan?.code === "score_incomplete", "code");
  assert(plan!.message.includes("fehlend: Krise, Trend"), plan!.message);
  assert(plan!.message.includes("FMP-Plan: keine Kursdaten"), plan!.message);

  const fund = preLlmAbort({
    scores: { ...scoresAll, fundamental: null },
    fundamentalResults: [http(402), http(402), http(402)],
    stockPriceResults: [okRows, okRows],
  });
  assert(fund!.message.includes("fehlend: Fundamental"), fund!.message);
  assert(fund!.message.includes("FMP-Plan: keine Kennzahlen"), fund!.message);

  const short = preLlmAbort({
    scores: { ...scoresAll, trend: null },
    fundamentalResults: [okRows],
    stockPriceResults: [empty, okRows],
  });
  assert(short!.message.includes("zu kurze Kurshistorie"), short!.message);

  const none = preLlmAbort({
    scores: { ...scoresAll, krise: null, trend: null },
    fundamentalResults: [okRows],
    stockPriceResults: [empty, empty],
  });
  assert(none!.message.includes("FMP liefert keine Kursdaten"), none!.message);
});
