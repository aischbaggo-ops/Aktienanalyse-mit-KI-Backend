// Aufruf (aus dem Repo-Root): deno test functions/_shared/priceHistory_test.ts
import { mergePriceResults, priceHistoryPaths } from "./priceHistory.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
const day = (date: string, close = 1) => ({ date, close });

Deno.test("Pfade: zwei Fenster ab 2000, Symbol URL-kodiert", () => {
  const [a, b] = priceHistoryPaths("^GSPC");
  assert(a === "/historical-price-eod/full?symbol=%5EGSPC&from=2000-01-01&to=2009-12-31", a);
  assert(b === "/historical-price-eod/full?symbol=%5EGSPC&from=2010-01-01", b);
  assert(priceHistoryPaths("BRK.B")[1].includes("symbol=BRK.B"), "Punkt bleibt");
});

Deno.test("Zusammenfuehren: beide Fenster, absteigend, Duplikate entfernt", () => {
  const older = { ok: true, data: [day("2009-12-31"), day("2000-01-03")], status: 200 };
  const newer = { ok: true, data: [day("2026-10-06"), day("2010-01-04"), day("2009-12-31", 2)], status: 200 };
  const m = mergePriceResults(older, newer);
  const dates = (m.data as any[]).map((r) => r.date);
  assert(m.ok === true, "ok");
  assert(dates.join() === "2026-10-06,2010-01-04,2009-12-31,2000-01-03", dates.join());
  assert((m.data as any[])[2].close === 2, "bei Duplikat gewinnt das neuere Fenster");
});

Deno.test("Junge Aktie: altes Fenster leer, Ergebnis aus dem neuen", () => {
  const m = mergePriceResults({ ok: true, data: [], status: 200 }, { ok: true, data: [day("2021-07-30")], status: 200 });
  assert(m.ok && (m.data as any[]).length === 1, "nur neues Fenster");
});

Deno.test("Ein Fenster scheitert: Daten des anderen bleiben, authError wird weitergereicht", () => {
  const m = mergePriceResults({ ok: false, error: "Premium", status: null }, { ok: true, data: [day("2020-01-02")], status: 200 });
  assert(m.ok && (m.data as any[]).length === 1, "Teildaten");
  const a = mergePriceResults({ ok: false, data: {}, authError: true, status: 401 }, { ok: true, data: [day("2020-01-02")], status: 200 });
  assert(a.authError === true, "authError aus einem Fenster");
});

Deno.test("Beide Fenster scheitern: nicht ok, Fehler bleibt erhalten", () => {
  const m = mergePriceResults({ ok: false, error: "x", status: 429 }, { ok: false, error: "Premium Query", status: null });
  assert(m.ok === false && m.error === "Premium Query", "Fehler");
});
