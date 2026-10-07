// Aufruf (aus dem Repo-Root): deno test functions/_shared/tickerCheck_test.ts
// Rein lokal, ohne Netz: der FMP-Abruf ist ein Stub.
import { CANARY_SYMBOL, checkTickers, failureMessage, resolveFmpSymbol, symbolVariants, type ProfileFetch } from "./tickerCheck.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const hit = (symbol: string) => ({ ok: true, status: 200, data: [{ symbol, companyName: "X" }] });
const empty = { ok: true, status: 200, data: [] };
const http = (status: number, data: unknown = {}) => ({ ok: false, status, data });

// Stub: kennt nur die angegebenen Symbole (genau diese Schreibweise).
function stub(known: string[], calls: string[] = []): ProfileFetch {
  return (s) => {
    calls.push(s);
    return Promise.resolve(known.includes(s) ? hit(s) : empty);
  };
}

Deno.test("gemischt gueltig/ungueltig: nur echte Ticker, Reihenfolge der Eingabe", async () => {
  const r = await checkTickers(["AAPL", "ZZZZ", "MSFT", "WALLETUSD"], stub(["AAPL", "MSFT"]));
  assert(r.failure === null, "kein Fehler");
  assert(JSON.stringify(r.valid) === JSON.stringify(["AAPL", "MSFT"]), `valid=${r.valid}`);
});

Deno.test("100 Symbole: alle gueltig, begrenzte Parallelitaet", async () => {
  const syms = Array.from({ length: 100 }, (_, i) => `T${i}`);
  let running = 0;
  let peak = 0;
  const f: ProfileFetch = async (s) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((res) => setTimeout(res, 1));
    running--;
    return hit(s);
  };
  const r = await checkTickers(syms, f, { concurrency: 10 });
  assert(r.valid.length === 100, "alle 100");
  assert(r.calls === 100, `Aufrufe=${r.calls}`);
  assert(peak <= 10, `Parallelitaet=${peak}`);
});

Deno.test("HTTP 200 ohne ein Ergebnis fuer ALLE: Pruefer kaputt, nicht 'alle ungueltig'", async () => {
  const r = await checkTickers(["AAPL2", "ABBV2", "AMZN2"], stub([])); // auch der Referenz-Ticker ist leer
  assert(r.failure === "no_results", `failure=${r.failure}`);
  assert(r.valid.length === 0, "nichts als gueltig melden");
});

Deno.test("echt ungueltige Ticker: Referenz-Ticker bestaetigt die Pruefung, Ergebnis leer ohne Fehler", async () => {
  const r = await checkTickers(["ZZZZ", "QQQQ"], stub([CANARY_SYMBOL]));
  assert(r.failure === null, "kein Pruefungsfehler");
  assert(r.valid.length === 0, "beide ungueltig");
  assert(r.calls === 3, `2 Ticker + 1 Referenz, war ${r.calls}`);
});

Deno.test("Referenz-Ticker in der Eingabe: kein Zusatzaufruf", async () => {
  const r = await checkTickers([CANARY_SYMBOL], stub([]));
  assert(r.calls === 1, "kein Referenzaufruf");
});

Deno.test("HTTP 402: Pruefungsfehler 'plan', Abbruch ohne weitere Aufrufe", async () => {
  const calls: string[] = [];
  const f: ProfileFetch = (s) => {
    calls.push(s);
    return Promise.resolve(http(402, "Premium Query Parameter"));
  };
  const r = await checkTickers(Array.from({ length: 50 }, (_, i) => `T${i}`), f, { concurrency: 5 });
  assert(r.failure === "plan", `failure=${r.failure}`);
  assert(r.failureStatus === 402, "Status 402");
  assert(calls.length <= 5, `Abbruch nach erster Welle, Aufrufe=${calls.length}`);
  assert(r.valid.length === 0, "nichts gueltig");
});

Deno.test("HTTP 429: Pruefungsfehler 'rate_limit'; ebenso Limit-Text bei 200", async () => {
  const r = await checkTickers(["AAPL", "MSFT"], () => Promise.resolve(http(429)));
  assert(r.failure === "rate_limit", `failure=${r.failure}`);
  const r2 = await checkTickers(["AAPL"], () =>
    Promise.resolve({ ok: true, status: 200, data: { "Error Message": "Limit Reach . Please upgrade" } })
  );
  assert(r2.failure === "rate_limit", `Text: ${r2.failure}`);
});

Deno.test("401/5xx/Netz: eigene Fehlerarten, nie 'ungueltig'", async () => {
  assert((await checkTickers(["AAPL"], () => Promise.resolve(http(401)))).failure === "auth", "auth");
  assert((await checkTickers(["AAPL"], () => Promise.resolve(http(503)))).failure === "outage", "outage");
  assert(
    (await checkTickers(["AAPL"], () => Promise.resolve({ ok: false, status: null, error: "fetch failed" }))).failure === "network",
    "network",
  );
  assert((await checkTickers(["AAPL"], () => Promise.resolve(http(418)))).failure === "other", "other");
});

Deno.test("Schreibweise: BRK.B nur als BRK-B bekannt -> gueltig, fmpSymbols haelt die FMP-Form", async () => {
  const calls: string[] = [];
  const r = await checkTickers(["BRK.B", "BF.B", "AAPL"], stub(["BRK-B", "BF-B", "AAPL"], calls));
  assert(r.valid.join() === "BRK.B,BF.B,AAPL", `valid=${r.valid}`);
  assert(r.fmpSymbols["BRK.B"] === "BRK-B" && r.fmpSymbols["BF.B"] === "BF-B", "Umschreibung gemerkt");
  assert(!("AAPL" in r.fmpSymbols), "AAPL unveraendert");
  // Umgekehrt: Eingabe mit Bindestrich, FMP kennt Punkt
  const r2 = await checkTickers(["BRK-B"], stub(["BRK.B"]));
  assert(r2.valid.join() === "BRK-B" && r2.fmpSymbols["BRK-B"] === "BRK.B", "Bindestrich -> Punkt");
});

Deno.test("Schreibweise: kennt FMP die Eingabeform, kein Zusatzaufruf", async () => {
  const calls: string[] = [];
  const r = await checkTickers(["BRK.B"], stub(["BRK.B"], calls));
  assert(r.valid.join() === "BRK.B" && calls.length === 1, "ein Aufruf");
  assert(Object.keys(r.fmpSymbols).length === 0, "keine Umschreibung");
});

Deno.test("symbolVariants / resolveFmpSymbol", async () => {
  assert(symbolVariants("aapl").join() === "AAPL", "einfach");
  assert(symbolVariants("BRK.B").join() === "BRK.B,BRK-B", "Punkt");
  assert(symbolVariants("BF-B").join() === "BF-B,BF.B", "Bindestrich");
  const calls: string[] = [];
  assert((await resolveFmpSymbol("AAPL", stub(["AAPL"], calls))) === "AAPL" && calls.length === 0, "ohne Zusatzaufruf");
  assert((await resolveFmpSymbol("BRK.B", stub(["BRK-B"]))) === "BRK-B", "Bindestrich-Form");
  assert((await resolveFmpSymbol("BRK.B", stub(["BRK.B"]))) === "BRK.B", "Punkt-Form");
  assert((await resolveFmpSymbol("XX.Y", stub([]))) === "XX.Y", "unbekannt -> Eingabe");
  assert((await resolveFmpSymbol("BRK.B", () => Promise.resolve(http(429)))) === "BRK.B", "429 -> Eingabe, analyse klassifiziert selbst");
});

Deno.test("Fehlermeldungen ohne Geheimnisse, mit Status", () => {
  assert(failureMessage("plan", 402).includes("402"), "402");
  assert(failureMessage("no_results", 200).includes("keinen Ticker"), "no_results");
});
