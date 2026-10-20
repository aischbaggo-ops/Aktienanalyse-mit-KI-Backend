import {
  regionForCountry, regionById, REGION_US, REGION_DE, REGION_STANDARD,
  KRISEN_US, KRISEN_EU, KRISE_EUROKRISE, ALLE_REGIONEN,
} from "./region.ts";
import { TREND3_CONFIG } from "./trend3.ts";
import { computeScores } from "./scoring.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FEHLGESCHLAGEN: " + msg);
}

function monatsreihe(abJahr: number, bisJahr = 2026) {
  const rows: { date: string; close: number }[] = [];
  let close = 100;
  for (let y = abJahr; y <= bisJahr; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === bisJahr && m > 10) break;
      const tag = new Date(Date.UTC(y, m, 0)).getUTCDate();
      rows.push({ date: `${y}-${String(m).padStart(2, "0")}-${tag}`, close });
      close *= 1.005;
    }
  }
  return rows;
}

const fmpInput = (stock: unknown[], index: unknown[]) => ({
  ticker: "TEST",
  profile: { ok: true, data: [] },
  priceStock: { ok: true, data: stock },
  priceIndex: { ok: true, data: index },
});

Deno.test("Land wird auf die Region abgebildet, Unbekanntes faellt auf die USA", () => {
  assert(regionForCountry("US") === REGION_US, "US");
  assert(regionForCountry("DE") === REGION_DE, "DE");
  assert(regionForCountry("de") === REGION_DE, "Kleinschreibung");
  assert(regionForCountry(" DE ") === REGION_DE, "Leerzeichen");
  // Bewusst kein harter Fehler: bis Methodik 3 wurde jede Aktie wie eine
  // US-Aktie gerechnet, ein Abbruch wuerde bestehende Analysen zerstoeren.
  assert(regionForCountry("FR") === REGION_STANDARD, "unbekanntes Land");
  assert(regionForCountry(null) === REGION_STANDARD, "null");
  assert(regionForCountry("") === REGION_STANDARD, "leer");
  assert(regionById("DE") === REGION_DE && regionById(null) === REGION_STANDARD, "regionById");
});

Deno.test("USA bleibt unveraendert gegenueber Methodik 3", () => {
  assert(REGION_US.benchmark === "^GSPC", "Benchmark ^GSPC");
  assert(REGION_US.trend === TREND3_CONFIG, "unveraenderte Trend-Schwellen");
  assert(REGION_US.trend.cagrGreen === 0.08, "CAGR 8 %");
  assert(REGION_US.crises.length === 5, "fuenf Krisenfenster");
  assert(REGION_US.prognose === true, "Prognose an");
  const namen = REGION_US.crises.map((c) => c.name).join(",");
  assert(namen === "Dotcom,Finanzkrise,Corona,Zins/Inflation,Zoll", `Reihenfolge: ${namen}`);
  const gewichte = REGION_US.crises.map((c) => c.r).join(",");
  assert(gewichte === "0.3,0.55,1,1.15,1.3", `Gewichte: ${gewichte}`);
});

Deno.test("computeScores ohne Region rechnet wie bisher", () => {
  // Der Standardwert der Signatur ist die US-Konfiguration. Ein Aufruf ohne
  // zweites Argument muss daher dasselbe Ergebnis liefern wie mit REGION_US.
  const stock = monatsreihe(2000), index = monatsreihe(2000);
  const ohne = computeScores(fmpInput(stock, index));
  const mit = computeScores(fmpInput(stock, index), REGION_US);
  assert(ohne.krise.score === mit.krise.score, "Krise gleich");
  assert(ohne.trend.score === mit.trend.score, "Trend gleich");
  assert(JSON.stringify(ohne.krise.crisisDetail) === JSON.stringify(mit.krise.crisisDetail),
    "Krisenfenster gleich");
  assert(ohne.region.id === "US", "Region im Ergebnis");
});

Deno.test("Deutschland: ^GDAXI, sechs Fenster, CAGR-Schwelle 6 %", () => {
  assert(REGION_DE.benchmark === "^GDAXI", "Benchmark ^GDAXI");
  assert(REGION_DE.trend.cagrGreen === 0.06, "CAGR 6 %");
  // Alles andere bleibt wie in der US-Konfiguration: Volatilitaet,
  // Unterwasser und Differenz werden relativ zum Heimatindex gemessen.
  assert(REGION_DE.trend.volaGreen === TREND3_CONFIG.volaGreen, "Vola unveraendert");
  assert(REGION_DE.trend.uwGreen === TREND3_CONFIG.uwGreen, "Unterwasser unveraendert");
  assert(REGION_DE.trend.diffEdge === TREND3_CONFIG.diffEdge, "Differenz unveraendert");
  assert(REGION_DE.trend.minMonthsPerWindow === 36, "36 Monate unveraendert");
  assert(REGION_DE.prognose === false, "Prognose aus");
  assert(REGION_DE.crises.length === 6, `sechs Fenster, waren ${REGION_DE.crises.length}`);
});

Deno.test("Eurokrise steht chronologisch zwischen Finanzkrise und Corona", () => {
  const namen = KRISEN_EU.map((c) => c.name);
  assert(namen.join(",") === "Dotcom,Finanzkrise,Eurokrise,Corona,Zins/Inflation,Zoll",
    `Reihenfolge: ${namen.join(",")}`);
  // Gewicht zwischen Finanzkrise (0,55) und Corona (1,0), passend zur
  // Staffelung nach Naehe zur Gegenwart.
  assert(KRISE_EUROKRISE.r > 0.55 && KRISE_EUROKRISE.r < 1.0,
    `Gewicht zwischen 0,55 und 1,0, war ${KRISE_EUROKRISE.r}`);
  assert(KRISE_EUROKRISE.from === "2011-07-01" && KRISE_EUROKRISE.to === "2012-07-31",
    "Fenster Juli 2011 bis Juli 2012");
  // Die US-Liste darf davon nichts abbekommen.
  assert(!KRISEN_US.some((c) => c.name === "Eurokrise"), "nicht in der US-Liste");
});

Deno.test("Das sechste Fenster veraendert die Krisen-Gewichtung", () => {
  const stock = monatsreihe(2000), index = monatsreihe(2000);
  const us = computeScores(fmpInput(stock, index), REGION_US);
  const de = computeScores(fmpInput(stock, index), REGION_DE);
  assert(us.krise.crisisDetail.length === 5, "US fuenf Fenster");
  assert(de.krise.crisisDetail.length === 6, "DE sechs Fenster");
  assert(de.krise.crisisDetail.some((c: { name: string }) => c.name === "Eurokrise"),
    "Eurokrise gerechnet");
});

Deno.test("Jede Region ist vollstaendig konfiguriert", () => {
  for (const r of ALLE_REGIONEN) {
    assert(r.id.length > 0 && r.name.length > 0, "Kennung und Name");
    assert(r.benchmark.startsWith("^"), `Benchmark-Symbol ${r.benchmark}`);
    assert(r.crises.length >= 5, `${r.id}: mindestens fuenf Fenster`);
    assert(r.crises.every((c) => c.from < c.to && c.r > 0), `${r.id}: Fenster plausibel`);
    assert(r.trend.cagrGreen > 0 && r.trend.minMonthsPerWindow === 36, `${r.id}: Trend-Schwellen`);
  }
  const ids = ALLE_REGIONEN.map((r) => r.id);
  assert(new Set(ids).size === ids.length, "Kennungen eindeutig");
});
