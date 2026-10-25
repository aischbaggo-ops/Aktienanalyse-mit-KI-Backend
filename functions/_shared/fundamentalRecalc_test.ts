// Aufruf (aus dem Repo-Root): deno test functions/_shared/fundamentalRecalc_test.ts
// Rein lokal, ohne Netz und ohne DB. Synthetische Abschluesse.
import { ausschuettungsAmpel, dividendeAusCashflow, dividendenStetigkeit, wesentlicheDividende } from "./scoring.ts";
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
  // Zusaetzliche Felder je Cashflow-Zeile, z. B. alle drei Dividendenfelder
  // mit den echten FMP-Werten. Dann dividende: () => null setzen.
  cfExtra?: (i: number) => Record<string, number>;
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
        ...(opts.cfExtra ? opts.cfExtra(i) : {}),
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

// --- Stammdividende und Wesentlichkeit -----------------------------------------------
// Realty Income, Arch Capital, Generac, Bloom Energy, Delivery Hero und
// Coca-Cola mit den echten FMP-Werten vom 25.10.2026
// (claude/fmp_europa_test_zusatz_20261025_142003.json, Mio. USD/EUR).
// "Nvidia-artig" und "Bayer-artig" sind gerundete Beispielwerte, keine FMP-Daten.

Deno.test("Realty Income: common 0, Betrag nur in net -> net minus preferred", () => {
  assert(dividendeAusCashflow({ commonDividendsPaid: 0, netDividendsPaid: -2699.5, preferredDividendsPaid: 0 }) === 2699.5,
    "Stammdividende aus net");
  assert(dividendeAusCashflow({ commonDividendsPaid: -2920.9, netDividendsPaid: -2920.9, preferredDividendsPaid: 0 }) === 2920.9,
    "common gefuellt: common");
});

Deno.test("Arch Capital: net ist reine Vorzugsdividende -> keine Stammdividende", () => {
  assert(dividendeAusCashflow({ commonDividendsPaid: 0, netDividendsPaid: -47, preferredDividendsPaid: -47 }) === 0,
    "nur Vorzug");
  assert(dividendeAusCashflow({ commonDividendsPaid: -1866, netDividendsPaid: -1906, preferredDividendsPaid: -40 }) === 1866,
    "Sonderdividende 2024");
  assert(dividendeAusCashflow({ commonDividendsPaid: 0 }) === 0, "nur common = 0: keine Dividende");
});

Deno.test("Wesentlichkeit: Kleinstbetraege zaehlen nicht, Symboldividende schon", () => {
  assert(wesentlicheDividende(0.3, 161.4, 4300) === 0, "Generac 0,2 % des Gewinns");
  assert(wesentlicheDividende(980, 72880, 130500) === 980, "Nvidia-artig 1,3 % des Gewinns");
  assert(wesentlicheDividende(54, -698.2, 12800) === 0, "Delivery Hero: Verlust, 0,4 % des Umsatzes");
  assert(wesentlicheDividende(1.5, -27.2, 1470) === 0, "Bloom Energy");
  assert(wesentlicheDividende(2360, -2950, 47600) === 2360, "Verlustjahr mit echter Dividende (Bayer-artig): 5 % des Umsatzes");
  assert(wesentlicheDividende(8779, 13137, 47000) === 8779, "Coca-Cola");
  assert(wesentlicheDividende(50, null, null) === 50, "ohne Bezugsgroesse unveraendert");
  assert(wesentlicheDividende(null, 100, 1000) === null && wesentlicheDividende(0, 100, 1000) === 0, "keine Dividende bleibt");
});

Deno.test("Gesamtrechnung Realty Income: alle fuenf Jahre Dividende, stetig gruen", () => {
  const net = [-1169.0, -1813.4, -2111.8, -2699.5, -2920.9];
  const r = rechneFundamental(abschluesse({
    dividende: () => null,
    cfExtra: (i) => ({ commonDividendsPaid: i < 4 ? 0 : net[i], netDividendsPaid: net[i], preferredDividendsPaid: 0 }),
    gewinn: (i) => [360.7, 872.4, 872.3, 867.3, 1069.8][i],
  }));
  const k = r.kriterien.find((x) => x.name === "Dividende stetig, keine Ausfaelle")!;
  assert(r.dividendenzahler && k.ampel === "gruen", `${k.ampel}: ${k.begruendung}`);
});

Deno.test("Gesamtrechnung Generac: kein Dividendenzahler", () => {
  const r = rechneFundamental(abschluesse({
    dividende: () => null,
    cfExtra: (i) => ({ commonDividendsPaid: [0, -0.3, 0, -0.3, -0.3][i], netDividendsPaid: [0, -0.3, 0, -0.3, -0.3][i], preferredDividendsPaid: 0 }),
    gewinn: (i) => [556.6, 408.9, 217.1, 317.0, 161.4][i],
  }));
  assert(!r.dividendenzahler && !namen(r.kriterien).some((n) => DIV.includes(n)), "keine Dividendenkriterien");
});

Deno.test("Gesamtrechnung Delivery Hero: Verluste, Kleinstbetraege - kein Zahler", () => {
  const r = rechneFundamental(abschluesse({
    dividende: () => null,
    cfExtra: (i) => ({ commonDividendsPaid: [0, 0, -3.3, 0, -54][i], netDividendsPaid: [0, 0, -3.3, 0, -54][i], preferredDividendsPaid: 0 }),
    gewinn: (i) => [-1096.5, -2975.1, -2297.5, -882.4, -698.2][i],
  }));
  assert(!r.dividendenzahler, "kein Zahler");
});

Deno.test("Gesamtrechnung Arch Capital: nur die Sonderdividende 2024 zaehlt", () => {
  const r = rechneFundamental(abschluesse({
    dividende: () => null,
    cfExtra: (i) => ({
      commonDividendsPaid: [0, 0, 0, -1866, -7][i], netDividendsPaid: [-47, -40, -40, -1906, -47][i],
      preferredDividendsPaid: [-47, -40, -40, -40, -40][i],
    }),
    gewinn: (i) => [2239.5, 1482.4, 4442, 4312, 4399][i],
  }));
  const k = r.kriterien.find((x) => x.name === "Dividende stetig, keine Ausfaelle")!;
  // 2024 erste Stammdividende, 2025 nur 7 Mio. (0,16 % des Gewinns): ein Ausfall seit Beginn.
  assert(r.dividendenzahler && k.ampel === "gelb", `${k.ampel}: ${k.begruendung}`);
  assert(String(k.begruendung).includes("seit der ersten Ausschuettung 2024"), String(k.begruendung));
});

// --- Dividende stetig: Ausfaelle erst ab der ersten Ausschuettung -------------------
// Entscheidung Michael vom 25.10.2026.

const D = ["2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31", "2025-12-31"];

Deno.test("Neubeginn ist kein Ausfall (Fall Alphabet, META): gruen", () => {
  // Dividende erst seit 2024 - vorher waren das drei Ausfaelle, also rot.
  const r = dividendenStetigkeit([null, 0, 0, 500, 600], D);
  assert(r.a === 1, `gruen, war ${r.a}`);
  assert(r.begruendung === "0 Jahr(e) ohne Dividende seit der ersten Ausschuettung 2024; die Jahre davor zaehlen nicht als Ausfall.",
    r.begruendung);
});

Deno.test("Aussetzen nach Beginn bleibt ein Ausfall (Fall Boeing, TUI)", () => {
  const zwei = dividendenStetigkeit([400, 0, 0, 300, 350], D);
  assert(zwei.a === 0, `zwei Ausfaelle rot, war ${zwei.a}`);
  const einer = dividendenStetigkeit([400, 410, 0, 300, 350], D);
  assert(einer.a === 0.5, `ein Ausfall gelb, war ${einer.a}`);
  // Zahlte und hoerte auf: die Jahre NACH dem Ende zaehlen.
  const ende = dividendenStetigkeit([400, 0, 0, 0, 0], D);
  assert(ende.a === 0 && ende.begruendung.startsWith("4 Jahr(e) ohne Dividende in den letzten 5"), ende.begruendung);
});

Deno.test("Durchgehende Dividende: gruen, Begruendung wie bisher", () => {
  const r = dividendenStetigkeit([400, 410, 420, 430, 440], D);
  assert(r.a === 1, "gruen");
  assert(r.begruendung === "0 Jahr(e) ohne Dividende in den letzten 5 verfuegbaren Jahren.", r.begruendung);
});

Deno.test("Neubeginn kommt in der Gesamtrechnung an", () => {
  const r = rechneFundamental(abschluesse({ dividende: (i) => (i < 3 ? null : -500) }));
  const k = r.kriterien.find((x) => x.name === "Dividende stetig, keine Ausfaelle")!;
  assert(k.ampel === "gruen" && String(k.begruendung).includes("seit der ersten Ausschuettung 2024"), `${k.ampel}: ${k.begruendung}`);
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
