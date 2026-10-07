// Aufruf (aus dem Repo-Root): deno test functions/_shared/scoring_test.ts
// Rein lokal, ohne Netz und ohne DB. Synthetische Kursreihen, keine FMP-Daten.
import { computeScores, notbremseTriggered, underwaterPhases } from "./scoring.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const AS_OF = new Date("2026-09-30");

function yearsBefore(asOf: Date, years: number): Date {
  return new Date(+asOf - years * YEAR_MS);
}

// Monatsreihe von 2000-01 bis 2026-09 mit frei vorgegebenem Verlauf je Monat.
function monthly(closeAt: (year: number, month: number) => number): { date: string; close: number }[] {
  const rows: { date: string; close: number }[] = [];
  for (let y = 2000; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 9) break;
      rows.push({ date: `${y}-${String(m).padStart(2, "0")}-15`, close: closeAt(y, m) });
    }
  }
  return rows;
}

// Hoch 100 im Monat (peakYear, 1), danach bis (recoverYear, 1) darunter, dann
// laufend neue Hochs. Davor stetig steigend bis 100.
function seriesWithPhase(peakYear: number, recoverYear: number): { date: string; close: number }[] {
  return monthly((y, m) => {
    const t = (y - 2000) * 12 + (m - 1);
    const peakT = (peakYear - 2000) * 12;
    const recoverT = (recoverYear - 2000) * 12;
    if (t < peakT) return 50 + (50 * t) / Math.max(peakT, 1);
    if (t === peakT) return 100;
    if (t < recoverT) return 80;
    return 100 + (t - recoverT) + 1;
  });
}

function fmpInput(stock: { date: string; close: number }[], index: { date: string; close: number }[]) {
  return {
    ticker: "TEST",
    profile: { ok: true, data: [] },
    priceStock: { ok: true, data: stock },
    priceIndex: { ok: true, data: index },
  };
}

function unterwasserAmpel(stock: { date: string; close: number }[], index: { date: string; close: number }[]) {
  const trend = computeScores(fmpInput(stock, index)).trend;
  const k = trend.kriterien.find((x: any) => x.name.startsWith("Laengste Unterwasser-Phase"));
  return k.a as number | null;
}

Deno.test("underwaterPhases: Phase beginnt unter dem Hoch, endet beim Wiedererreichen", () => {
  const rows = [
    { date: "2000-01-31", close: 100 },
    { date: "2000-02-29", close: 90 },
    { date: "2000-03-31", close: 95 },
    { date: "2000-04-30", close: 100 },
    { date: "2000-05-31", close: 110 },
  ];
  const phases = underwaterPhases(rows);
  assert(phases.length === 1, "eine Phase");
  assert(!phases[0].open, "nicht offen");
  assert(phases[0].start.toISOString().startsWith("2000-02-29"), "Start = erster Schlusskurs unter dem Hoch");
  assert(phases[0].end.toISOString().startsWith("2000-04-30"), "Ende = erster Schlusskurs auf dem Hoch");
});

Deno.test("underwaterPhases: laufende Phase ist offen und reicht bis zum letzten Kurs", () => {
  const phases = underwaterPhases([
    { date: "2020-01-31", close: 100 },
    { date: "2021-01-31", close: 80 },
    { date: "2022-01-31", close: 70 },
  ]);
  assert(phases.length === 1 && phases[0].open, "offene Phase");
  assert(Math.abs(phases[0].years - 1.0) < 0.02, "ca. 1 Jahr");
});

Deno.test("underwaterPhases: laengste Phase ist identisch zur bisherigen Rechnung", () => {
  function reference(rows: { date: string; close: number }[]): number {
    let peak = rows[0].close, start: Date | null = null, longest = 0;
    for (const r of rows) {
      if (r.close >= peak) {
        peak = r.close;
        if (start) { longest = Math.max(longest, (+new Date(r.date) - +start) / (365.25 * 24 * 3600 * 1000)); start = null; }
      } else if (!start) start = new Date(r.date);
    }
    if (start) longest = Math.max(longest, (+new Date(rows[rows.length - 1].date) - +start) / (365.25 * 24 * 3600 * 1000));
    return longest;
  }
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 5; run++) {
    let price = 100;
    const rows = monthly(() => (price = Math.max(1, price * (0.9 + rand() * 0.22))));
    const longest = underwaterPhases(rows).reduce((m, p) => Math.max(m, p.years), 0);
    assert(Math.abs(longest - reference(rows)) < 1e-9, `Lauf ${run}: ${longest} vs ${reference(rows)}`);
  }
});

Deno.test("Notbremse: Phase von 8 Jahren, Ende vor 16 Jahren -> keine Notbremse", () => {
  const end = yearsBefore(AS_OF, 16);
  const start = yearsBefore(end, 8);
  const phases = [{ start, end, years: 8, open: false }];
  assert(!notbremseTriggered(phases, AS_OF), "Alt-Durststrecke loest nicht aus");
});

Deno.test("Notbremse: Phase von 8 Jahren, Ende vor 5 Jahren -> Notbremse", () => {
  const end = yearsBefore(AS_OF, 5);
  const start = yearsBefore(end, 8);
  assert(notbremseTriggered([{ start, end, years: 8, open: false }], AS_OF), "rot");
});

Deno.test("Notbremse: laufende Phase ueber 7 Jahre -> Notbremse", () => {
  const start = yearsBefore(AS_OF, 8);
  assert(notbremseTriggered([{ start, end: AS_OF, years: 8, open: true }], AS_OF), "offene Phase");
});

Deno.test("Notbremse: Phase von 7 Jahren oder kuerzer -> keine Notbremse", () => {
  const end = yearsBefore(AS_OF, 2);
  assert(!notbremseTriggered([{ start: yearsBefore(end, 7), end, years: 7, open: false }], AS_OF), "genau 7 Jahre");
  assert(!notbremseTriggered([{ start: yearsBefore(end, 6), end, years: 6, open: false }], AS_OF), "6 Jahre");
});

Deno.test("Notbremse: Phase beginnt vor dem Fenster, reicht aber hinein -> Notbremse", () => {
  const end = yearsBefore(AS_OF, 10);
  const start = yearsBefore(end, 8);
  assert(start < yearsBefore(AS_OF, 15), "Beginn liegt vor dem 15-Jahres-Fenster");
  assert(notbremseTriggered([{ start, end, years: 8, open: false }], AS_OF), "Ende im Fenster");
});

Deno.test("Notbremse: alte lange und neue kurze Phase -> keine Notbremse", () => {
  const oldEnd = yearsBefore(AS_OF, 16);
  const recentEnd = yearsBefore(AS_OF, 3);
  const phases = [
    { start: yearsBefore(oldEnd, 9), end: oldEnd, years: 9, open: false },
    { start: yearsBefore(recentEnd, 2), end: recentEnd, years: 2, open: false },
  ];
  assert(!notbremseTriggered(phases, AS_OF), "nur kurze Phase im Fenster");
});

Deno.test("Trend-Ampel: Phase endet vor ca. 16 Jahren -> Ampel aus dem Verhaeltnis, nicht rot", () => {
  // Hoch 2002, 8 Jahre darunter, Erholung 2010 (Ende ca. 16,6 Jahre vor dem letzten Kurs).
  const stock = seriesWithPhase(2002, 2010);
  const a = unterwasserAmpel(stock, stock);
  assert(a === 0.5, `Verhaeltnis 1,0 -> gelb (0,5), war ${a}`);
});

Deno.test("Trend-Ampel: Phase von 8 Jahren endet vor ca. 5 Jahren -> rot trotz Verhaeltnis 1,0", () => {
  // Hoch 2013, 8 Jahre darunter, Erholung 2021 (Ende ca. 5,7 Jahre vor dem letzten Kurs).
  const stock = seriesWithPhase(2013, 2021);
  const a = unterwasserAmpel(stock, stock);
  assert(a === 0, `Notbremse -> rot (0), war ${a}`);
});

Deno.test("Trend-Ampel: ohne Phase ueber 7 Jahre bleibt das Verhaeltnis massgeblich", () => {
  const stock = seriesWithPhase(2013, 2018); // 5 Jahre
  const index = seriesWithPhase(2013, 2021); // 8 Jahre -> Verhaeltnis 0,625
  const a = unterwasserAmpel(stock, index);
  assert(a === 1, `Verhaeltnis < 0,8 -> gruen (1), war ${a}`);
});
