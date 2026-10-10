import {
  addMonths, cagrInWindow, annualReturns, populationStdDev, longestUnderwaterYears,
  computeTrend3, computeTotalWithTrend3, TREND3_CONFIG, NICHT_BEWERTBAR_KURZE_HISTORIE,
  nichtBewertbarFelder, type PriceRow,
} from "./trend3.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FEHLGESCHLAGEN: " + msg);
}
function near(a: number | null, b: number, tol = 1e-6, msg = "") {
  assert(a !== null && Math.abs(a - b) < tol, `${msg} (erwartet ${b}, war ${a})`);
}

// Monatsreihe mit konstanter Jahresrendite, Monatsletzter.
function series(startYear: number, startMonth: number, months: number,
                start: number, monthlyFactor: number): PriceRow[] {
  const rows: PriceRow[] = [];
  let close = start;
  for (let i = 0; i < months; i++) {
    const total = startYear * 12 + (startMonth - 1) + i;
    const y = Math.floor(total / 12), m = total - y * 12 + 1;
    const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
    rows.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, close });
    close *= monthlyFactor;
  }
  return rows;
}

Deno.test("addMonths klemmt den Monatsueberlauf", () => {
  assert(addMonths("2026-10-31", -120) === "2016-10-31", "10 Jahre zurueck");
  assert(addMonths("2026-03-31", -1) === "2026-02-28", "31.03. minus 1 Monat");
  assert(addMonths("2026-01-15", -12) === "2025-01-15", "ein Jahr");
  assert(addMonths("2026-01-31", -13) === "2024-12-31", "Jahreswechsel");
});

Deno.test("cagrInWindow rechnet geometrisch, nicht arithmetisch", () => {
  // Verdoppelung in genau 10 Jahren -> 2^(1/10) - 1 = 7,177 %
  const rows: PriceRow[] = [
    { date: "2016-10-31", close: 100 },
    { date: "2021-10-29", close: 50 },   // Zwischeneinbruch darf egal sein
    { date: "2026-10-30", close: 200 },
  ];
  const c = cagrInWindow(rows, "2016-10-30", "2026-10-31");
  near(c, Math.pow(2, 1 / yearsOf("2016-10-31", "2026-10-30")) - 1, 1e-9, "CAGR Verdoppelung");
  // Der arithmetische Mittelwert der beiden Jahresabschnitte waere deutlich
  // hoeher - genau das ist der Unterschied zu Methodik 2.
  assert((c as number) < 0.09, "geometrisch bleibt unter 9 %");
});

function yearsOf(a: string, b: string) {
  return (Date.parse(b) - Date.parse(a)) / (365.25 * 24 * 3600 * 1000);
}

Deno.test("cagrInWindow liefert null ohne ausreichenden Zeitraum", () => {
  const rows = series(2026, 1, 6, 100, 1.01);
  assert(cagrInWindow(rows, "2025-12-31", "2026-06-30") === null, "unter einem Jahr");
});

Deno.test("annualReturns ist am Stichtag verankert", () => {
  // 13 Monatspunkte, jeden Monat +1 % -> Jahresrendite 1,01^12 - 1
  const rows = series(2025, 10, 13, 100, 1.01);
  const rets = annualReturns(rows, "2026-10-31", "2025-10-01", "2026-10-31");
  assert(rets.length === 1, `eine Jahresrendite, war ${rets.length}`);
  near(rets[0], Math.pow(1.01, 12) - 1, 1e-9, "Jahresrendite");
});

Deno.test("annualReturns zaehlt nur Renditen im Fenster", () => {
  const rows = series(2006, 1, 250, 100, 1.005);
  const w1 = annualReturns(rows, "2026-10-31", "2016-10-31", "2026-10-31");
  const w2 = annualReturns(rows, "2026-10-31", "2006-10-31", "2016-10-31");
  assert(w1.length === 10, `Fenster 1 hat 10 Renditen, war ${w1.length}`);
  assert(w2.length === 10, `Fenster 2 hat 10 Renditen, war ${w2.length}`);
});

Deno.test("populationStdDev braucht zwei Werte", () => {
  assert(populationStdDev([0.1]) === null, "ein Wert -> null");
  near(populationStdDev([0.1, 0.3]), 0.1, 1e-12, "Standardabweichung");
});

Deno.test("longestUnderwaterYears findet die laengste Phase", () => {
  const rows: PriceRow[] = [
    { date: "2010-01-31", close: 100 },
    { date: "2011-01-31", close: 80 },
    { date: "2015-01-31", close: 120 },   // Phase 2010-01 bis 2015-01 = 5 Jahre
    { date: "2016-01-31", close: 110 },
    { date: "2017-01-31", close: 130 },   // Phase 1 Jahr
  ];
  // underwaterPhases() aus scoring.ts zaehlt ab dem ersten Kurs UNTER dem Hoch,
  // nicht ab dem Hoch selbst: 2011-01 bis 2015-01 sind 4 Jahre. Bei Tageskursen
  // ist das ein Tag Unterschied; hier faellt es auf, weil die Testreihe nur
  // Jahrespunkte hat. Bewusst uebernommen, damit die 7-Jahres-Notbremse
  // dieselbe Bedeutung wie in Methodik 2 behaelt.
  const y = longestUnderwaterYears(rows, "2009-12-31", "2017-12-31");
  assert(y !== null && y > 3.9 && y < 4.1, `rund 4 Jahre, war ${y}`);
});

Deno.test("Index ohne Unterwasser-Phase: rot statt grau", () => {
  // Der Index steigt im gemeinsamen Zeitraum ununterbrochen, die Aktie nicht.
  // Ein Verhaeltnis ist nicht bildbar; grau wuerde das Kriterium ausfallen
  // lassen und die Aktie dadurch belohnen.
  const index = series(2016, 10, 120, 1000, 1.004);
  const stock: PriceRow[] = series(2016, 10, 120, 100, 1.004)
    .map((r, i) => ({ ...r, close: i >= 12 && i < 60 ? r.close * 0.7 : r.close }));
  const r = computeTrend3(stock, index);
  assert(r.kennzahlen.uwIndexYears === 0, `Index ohne Phase, war ${r.kennzahlen.uwIndexYears}`);
  assert(r.kennzahlen.uwRatio === null, "kein Verhaeltnis");
  assert(r.ampeln.uw === 0, `Unterwasser rot, war ${r.ampeln.uw}`);

  // Beide ohne Phase -> gruen.
  const both = computeTrend3(series(2016, 10, 120, 100, 1.004), index);
  assert(both.kennzahlen.uwRatio === null && both.ampeln.uw === 1, "beide ohne Phase -> gruen");
});

Deno.test("Fenster unter 36 Monaten faellt weg, Gewichte werden normalisiert", () => {
  // Aktie mit 12 Jahren Historie: Fenster 1 voll, Fenster 2 mit 24 Monaten
  // (faellt weg), Fenster 3 existiert nicht.
  const stock = series(2014, 11, 144, 100, 1.006);
  const index = series(2000, 1, 322, 1000, 1.004);
  const r = computeTrend3(stock, index);
  assert(r.nFenster === 1, `nur Fenster 1 gilt, waren ${r.nFenster}`);
  assert(r.fenster[0].faktor === 2, "Faktor 2");
  assert(r.score !== null, "Score vorhanden");
});

Deno.test("ohne gueltiges Fenster gibt es keinen Trend-Score", () => {
  const stock = series(2024, 6, 29, 100, 1.01);   // 29 Monate
  const index = series(2000, 1, 322, 1000, 1.004);
  const r = computeTrend3(stock, index);
  assert(r.score === null, "Score null");
  assert(r.nFenster === 0, "kein Fenster");
  assert(r.nichtBewertbar === NICHT_BEWERTBAR_KURZE_HISTORIE, "Grund benannt");
  assert(r.kriterien.length === 0, "keine Kriterien");
  assert(computeTotalWithTrend3(70, 70, 70, r.score) === null, "kein Gesamtscore");
});

Deno.test("Ampeln an den Schwellen aus Trend_Schwellen_v1.md", () => {
  const cfg = TREND3_CONFIG;
  assert(cfg.cagrGreen === 0.08, "CAGR gruen ab 8 %");
  assert(cfg.volaGreen === 0.25 && cfg.volaYellow === 0.35, "Vola 0,25 / 0,35");
  assert(cfg.diffEdge === 0.01, "Differenz 1 Pp");
  assert(cfg.minMonthsPerWindow === 36, "36 Monate");

  const index = series(2000, 1, 322, 1000, 1.004);   // ca. 4,9 % p. a.
  // Aktie klar besser als der Index und ruhig -> CAGR und Differenz gruen.
  const strong = computeTrend3(series(2000, 1, 322, 100, 1.009), index);
  assert(strong.ampeln.cagr === 1, "CAGR gruen");
  assert(strong.ampeln.diff === 1, "Differenz gruen");
  assert(strong.ampeln.vola === 1, "gleichmaessiger Verlauf -> Vola gruen");
  // Fallende Aktie -> CAGR rot, Differenz rot.
  const weak = computeTrend3(series(2000, 1, 322, 100, 0.998), index);
  assert(weak.ampeln.cagr === 0, "CAGR rot");
  assert(weak.ampeln.diff === 0, "Differenz rot");
});

Deno.test("Index wird nur ueber den gemeinsamen Zeitraum verglichen (A2)", () => {
  // Index: 2000 bis 2026 mit einem langen Einbruch 2000-2010, danach ruhig.
  const index: PriceRow[] = [];
  for (let i = 0; i < 322; i++) {
    const total = 2000 * 12 + i;
    const y = Math.floor(total / 12), m = total - y * 12 + 1;
    const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // Erst faellt der Index zehn Jahre (lange Phase 2000-2010), dann steigt er
    // mit einem kurzen Einbruch von rund einem Jahr um 2020.
    let close = i < 120 ? 1000 - i * 4 : 520 + (i - 120) * 6;
    if (i >= 240 && i < 252) close = 520 + (240 - 120) * 6 - 40;
    index.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, close });
  }
  // Junge Aktie ab 2016 mit einer dreijaehrigen Unterwasser-Phase.
  const stock: PriceRow[] = [];
  for (let i = 0; i < 120; i++) {
    const total = 2016 * 12 + 9 + i;
    const y = Math.floor(total / 12), m = total - y * 12 + 1;
    const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const close = i < 12 ? 100 + i : i < 48 ? 112 - (i - 12) * 0.8 : 83 + (i - 48) * 1.2;
    stock.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, close });
  }
  const r = computeTrend3(stock, index);
  assert(r.gemeinsamerStart?.startsWith("2016-10"), `gemeinsamer Start 2016-10, war ${r.gemeinsamerStart}`);
  // Der Index hat ab 2016 keine lange Phase mehr; wuerde man ihn ab 2000
  // rechnen, waere der Nenner ueber 10 Jahre und das Verhaeltnis winzig.
  assert(r.kennzahlen.uwIndexYears !== null && r.kennzahlen.uwIndexYears < 3,
    `Index-Phase im gemeinsamen Zeitraum kurz, war ${r.kennzahlen.uwIndexYears}`);
  assert(r.kennzahlen.uwRatio !== null && r.kennzahlen.uwRatio > 1.2,
    `Verhaeltnis ueber 1,2, war ${r.kennzahlen.uwRatio}`);
  assert(r.ampeln.uw === 0, "Unterwasser rot");
});

Deno.test("Notbremse setzt Unterwasser auf rot", () => {
  // Hoch 2012, danach 8 Jahre unter Wasser, Erholung 2020.
  const rows: PriceRow[] = [];
  for (let i = 0; i < 180; i++) {
    const total = 2012 * 12 + i;
    const y = Math.floor(total / 12), m = total - y * 12 + 1;
    const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const close = i === 0 ? 200 : i < 100 ? 100 + i * 0.3 : 130 + (i - 100) * 1.5;
    rows.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, close });
  }
  const index = series(2000, 1, 322, 1000, 1.004);
  const r = computeTrend3(rows, index);
  assert(r.notbremse, "Notbremse greift");
  assert(r.ampeln.uw === 0, "Unterwasser rot");
  assert(r.kriterien.find((k) => k.name.includes("Unterwasser"))!.begruendung.includes("Notbremse"),
    "Begruendung nennt die Notbremse");
});

Deno.test("Gesamtscore nach Spec Abschnitt 1", () => {
  assert(computeTotalWithTrend3(80, 70, 60, 50) === Math.round(0.35 * 80 + 0.25 * 70 + 0.2 * 60 + 0.2 * 50),
    "Gewichte 0,35/0,25/0,20/0,20");
  assert(computeTotalWithTrend3(80, 70, 60, null) === null, "fehlender Trend -> null");
  assert(computeTotalWithTrend3(null, 70, 60, 50) === null, "fehlendes Fundamental -> null");
});

Deno.test("Kriterien behalten die Form aus der Datenbank", () => {
  const r = computeTrend3(series(2000, 1, 322, 100, 1.006), series(2000, 1, 322, 1000, 1.004));
  assert(r.kriterien.length === 4, "vier Kriterien");
  for (const k of r.kriterien) {
    assert(k.dimension === "Trend", "dimension");
    assert(typeof k.name === "string" && k.name.length > 0, "name");
    assert(["gruen", "gelb", "rot", "grau"].includes(k.ampel), `ampel ${k.ampel}`);
    assert(typeof k.begruendung === "string" && k.begruendung.length > 0, "begruendung");
    assert(Object.keys(k).sort().join(",") === "ampel,begruendung,dimension,name", "keine Zusatzfelder");
  }
});

Deno.test("nichtBewertbarFelder passt zu dem, was die Tabelle liest", () => {
  const f = nichtBewertbarFelder("Kurshistorie unter 3 Jahren");
  // assessmentText() im Frontend verlangt genau diesen Code, sonst "Fehler".
  assert(f.last_run_error_code === "score_incomplete", "Code score_incomplete");
  assert(f.status === "error" && f.last_run_status === "error", "beide Status error");
  // Der Klammertext der Tabelle haengt an diesem Teilstring.
  assert(f.last_run_error_public.includes("zu kurze Kurshistorie"), "Teilstring fuer den Klammertext");
  // Zusatz fuer den Tooltip.
  assert(f.last_run_error_public.includes("36 Monatskurse"), "Zusatz 36 Monatskurse");
  assert(f.error_message_public === f.last_run_error_public, "oeffentliche Texte gleich");
  assert(f.error_message.includes("Methodik 3"), "interne Meldung nennt die Methodik");
});

Deno.test("nichtBewertbarFelder setzt genau die erwarteten Spalten", () => {
  const keys = Object.keys(nichtBewertbarFelder(null)).sort().join(",");
  assert(keys === "error_message,error_message_public,last_run_error_code," +
    "last_run_error_public,last_run_status,status", `Spalten: ${keys}`);
});
