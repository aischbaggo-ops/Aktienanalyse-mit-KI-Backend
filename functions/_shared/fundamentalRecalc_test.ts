// Aufruf (aus dem Repo-Root): deno test functions/_shared/fundamentalRecalc_test.ts
// Rein lokal, ohne Netz und ohne DB. Synthetische Abschluesse.
import { ausschuettungsAmpel, dividendeAusCashflow } from "./scoring.ts";
import {
  aendertSich, gesamtNeu, kriterienErsetzen, ohneDividendenfelder, rechneFundamental, type Abschluesse,
} from "./fundamentalRecalc.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const JAHRE = ["2021", "2022", "2023", "2024", "2025"];

// Solides Unternehmen mit stetiger Dividende. dividende(i) und gewinn(i)
// lassen sich je Test ueberschreiben.
function abschluesse(opts: {
  dividende?: (i: number) => number | null;
  gewinn?: (i: number) => number;
  fcf?: (i: number) => number;
  feld?: string;
} = {}): Abschluesse {
  const dividende = opts.dividende ?? (() => -400);
  const gewinn = opts.gewinn ?? ((i) => 1000 + 100 * i);
  const fcf = opts.fcf ?? ((i) => 1100 + 100 * i);
  const feld = opts.feld ?? "commonDividendsPaid";
  const datum = (j: string) => `${j}-12-31`;
  return {
    income: { ok: true, data: JAHRE.map((j, i) => ({
      date: datum(j), revenue: 10000 + 500 * i, netIncome: gewinn(i), operatingIncome: 1500 + 80 * i,
      grossProfit: 4000 + 200 * i, ebitda: 2000 + 100 * i, weightedAverageShsOutDil: 1000 - 5 * i,
      incomeBeforeTax: 1300 + 100 * i, incomeTaxExpense: 300,
    })) },
    balance: { ok: true, data: JAHRE.map((j) => ({
      date: datum(j), totalAssets: 20000, totalLiabilities: 9000, totalDebt: 3000,
      cashAndCashEquivalents: 1000, goodwill: 2000, totalStockholdersEquity: 11000,
    })) },
    cashflow: { ok: true, data: JAHRE.map((j, i) => {
      const d = dividende(i);
      return {
        date: datum(j), freeCashFlow: fcf(i), operatingCashFlow: fcf(i) + 400,
        ...(d === null ? {} : { [feld]: d }),
      };
    }) },
    estimates: { ok: true, data: [] },
  };
}

const namen = (k: Record<string, unknown>[]) => k.map((x) => String(x.name));
const DIV = ["Dividende stetig, keine Ausfaelle", "Dividende <= Gewinn", "Dividende <= Free Cashflow"];

// --- Feldnamen -----------------------------------------------------------------

Deno.test("Dividende wird unter allen drei FMP-Feldnamen erkannt, als positiver Betrag", () => {
  assert(dividendeAusCashflow({ commonDividendsPaid: -8779 }) === 8779, "commonDividendsPaid (stable-API)");
  assert(dividendeAusCashflow({ netDividendsPaid: -500 }) === 500, "netDividendsPaid als Rueckfall");
  assert(dividendeAusCashflow({ dividendsPaid: -300 }) === 300, "alter Name bleibt lesbar");
  assert(dividendeAusCashflow({ commonDividendsPaid: -10, netDividendsPaid: -99 }) === 10, "Stammaktien zuerst");
  assert(dividendeAusCashflow({ freeCashFlow: 5 }) === null, "ohne Feld: null");
  assert(dividendeAusCashflow(null) === null, "ohne Zeile: null");
});

// --- Ausschuettungsquote ---------------------------------------------------------

Deno.test("Dividende bei Verlust oder negativem FCF ist rot, nicht gruen", () => {
  // Vorher wurde die negative Quote als "<= 60 %" gewertet: gruen.
  const [a, text] = ausschuettungsAmpel(400, -139, "Gewinn", "Verlust");
  assert(a === 0, `rot, war ${a}`);
  assert(text === "Dividende trotz Verlust.", text);
  assert(ausschuettungsAmpel(400, -1, "FCF", "negativem FCF")[1] === "Dividende trotz negativem FCF.", "FCF-Text");
});

Deno.test("Quoten-Schwellen unveraendert: <= 60 % gruen, <= 100 % gelb, darueber rot", () => {
  assert(ausschuettungsAmpel(50, 100, "Gewinn", "Verlust")[0] === 1, "50 %");
  assert(ausschuettungsAmpel(80, 100, "Gewinn", "Verlust")[0] === 0.5, "80 %");
  assert(ausschuettungsAmpel(150, 100, "Gewinn", "Verlust")[0] === 0, "150 %");
  assert(ausschuettungsAmpel(50, 100, "Gewinn", "Verlust")[1] === "Ausschuettungsquote vs. Gewinn 50%.", "Text wie bisher");
  assert(ausschuettungsAmpel(null, 100, "Gewinn", "Verlust")[0] === null, "ohne Dividende grau");
  assert(ausschuettungsAmpel(50, 0, "Gewinn", "Verlust")[0] === null, "Basis 0 grau");
});

// --- Rechnung ---------------------------------------------------------------------

Deno.test("Dividendenzahler bekommt die drei Kriterien", () => {
  const r = rechneFundamental(abschluesse());
  assert(r.dividendenzahler, "erkannt");
  for (const n of DIV) assert(namen(r.kriterien).includes(n), `Kriterium ${n}`);
  assert(r.score !== null, "Score bestimmbar");
  assert(r.letztesJahr === "2025", `letztes Jahr ${r.letztesJahr}`);
});

Deno.test("Ohne Dividendenfelder rechnet es wie der alte Code: keine Dividendenkriterien", () => {
  const d = abschluesse();
  const r = rechneFundamental({ ...d, cashflow: ohneDividendenfelder(d.cashflow) });
  assert(!r.dividendenzahler, "nicht erkannt");
  assert(!namen(r.kriterien).some((n) => DIV.includes(n)), "keine Dividendenkriterien");
});

Deno.test("Auch der alte Feldname fuehrt zu den Kriterien", () => {
  const r = rechneFundamental(abschluesse({ feld: "dividendsPaid" }));
  assert(r.dividendenzahler && namen(r.kriterien).includes(DIV[0]), "alter Name");
});

Deno.test("Kein Dividendenzahler: unveraendert keine Dividendenkriterien", () => {
  const r = rechneFundamental(abschluesse({ dividende: () => null }));
  assert(!r.dividendenzahler && !namen(r.kriterien).some((n) => DIV.includes(n)), "keine");
  const z = rechneFundamental(abschluesse({ dividende: () => 0 }));
  assert(!z.dividendenzahler, "Dividende 0 heisst: zahlt keine");
});

Deno.test("Verlustjahr mit Dividende (Fall Smucker): Dividende <= Gewinn rot", () => {
  const r = rechneFundamental(abschluesse({ gewinn: (i) => (i === 4 ? -139 : 700) }));
  const k = r.kriterien.find((x) => x.name === "Dividende <= Gewinn")!;
  assert(k.ampel === "rot" && k.begruendung === "Dividende trotz Verlust.", `${k.ampel}: ${k.begruendung}`);
});

// --- Zeile zusammensetzen -----------------------------------------------------------

Deno.test("Nur die Fundamental-Kriterien werden ersetzt, Fundamental steht vorn", () => {
  const alt = [
    { dimension: "Fundamental", name: "Alt-F", ampel: "rot" },
    { dimension: "Qualitaet", name: "Q1", ampel: "gruen" },
    { dimension: "Trend", name: "T1", ampel: "gelb" },
  ];
  const neu = kriterienErsetzen(alt, [{ name: "Neu-F", ampel: "gruen" }]);
  assert(neu.length === 3, `drei Eintraege, waren ${neu.length}`);
  assert(neu[0].name === "Neu-F" && neu[0].dimension === "Fundamental", "neues F vorn, mit Dimension");
  assert(neu[1].name === "Q1" && neu[2].name === "T1", "Qualitaet und Trend unveraendert, in Reihenfolge");
  assert(!neu.some((k) => k.name === "Alt-F"), "altes F weg");
});

Deno.test("Geschrieben wird nur bei echter Aenderung", () => {
  const r = rechneFundamental(abschluesse());
  const gespeichert = kriterienErsetzen([], r.kriterien);
  assert(!aendertSich(Math.round(r.score!), gespeichert, r), "gleicher Score, gleiche Ampeln: nein");
  assert(aendertSich(Math.round(r.score!) - 5, gespeichert, r), "anderer Score: ja");
  const andereAmpel = gespeichert.map((k, i) => (i === 0 ? { ...k, ampel: k.ampel === "rot" ? "gruen" : "rot" } : k));
  assert(aendertSich(Math.round(r.score!), andereAmpel, r), "gleicher Score, andere Ampel: ja");
  assert(!aendertSich(70, gespeichert, { ...r, score: null }), "neuer Score nicht bestimmbar: nein");
});

Deno.test("Gesamtscore nach der Gewichtung, auch mit Zahlen als Text (PostgREST)", () => {
  assert(gesamtNeu(80, 90 as unknown as number, "60" as unknown as number, "50" as unknown as number) ===
    Math.round(0.35 * 80 + 0.25 * 90 + 0.2 * 60 + 0.2 * 50), "Formel");
  assert(gesamtNeu(80, null, 60, 50) === null, "ohne Q kein Gesamtscore");
});
