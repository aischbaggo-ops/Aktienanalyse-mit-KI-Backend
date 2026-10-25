// ---------------------------------------------------------------------------
// Fundamental nachrechnen, ohne Claude (fuer recalc-fundamental)
// ---------------------------------------------------------------------------
// Anlass: Der Code las das Dividendenfeld unter dem Namen der alten FMP-API
// ("dividendsPaid"). Bei allen 594 Analysen bis zum 24.10.2026 galt deshalb
// kein Wert als Dividendenzahler, die drei Dividendenkriterien liefen nie.
// Fundamental ist reine Rechnung aus GuV, Bilanz, Cashflow und Schaetzungen -
// er laesst sich wie der Trend (recalc-trend) ohne Claude neu bestimmen.
//
// Rein, ohne Netz und ohne Datenbank: testbar in fundamentalRecalc_test.ts.
// Die eigentliche Rechnung ist computeScores() aus scoring.ts - dieselbe
// Funktion, die analyse benutzt. Es gibt bewusst keine zweite Fassung.
// ---------------------------------------------------------------------------
import { arr, computeScores } from "./scoring.ts";
import { computeTotalWithTrend3 } from "./trend3.ts";

type FmpErgebnis = { ok?: boolean; data?: unknown };

export interface Abschluesse {
  income: FmpErgebnis;
  balance: FmpErgebnis;
  cashflow: FmpErgebnis;
  estimates: FmpErgebnis;
}

export interface FundamentalErgebnis {
  score: number | null;
  kriterien: Record<string, unknown>[];
  series: Record<string, unknown>;
  dividendenzahler: boolean;
  koVerschuldung: boolean;
  letztesJahr: string | null;
}

const KO_VERSCHULDUNG_PRAEFIX = "Dynamischer Verschuldungsgrad zweistellig";
const LEER: FmpErgebnis = { ok: true, data: [] };

export function rechneFundamental(d: Abschluesse): FundamentalErgebnis {
  // Kurse, Profil und Nachrichten braucht der Fundamentalteil nicht. Leer
  // uebergeben: Krise und Trend werden dann nicht bestimmbar und hier ohnehin
  // nicht verwendet.
  const s = computeScores({
    ticker: "", profile: LEER, peers: LEER, news: LEER, dcf: LEER,
    priceStock: LEER, priceIndex: LEER, ...d,
  });
  const series = s.fundamentalSeries as Record<string, unknown>;
  const jahre = Array.isArray(series?.years) ? series.years as string[] : [];
  return {
    score: s.fundamental.score,
    kriterien: s.fundamental.kriterien,
    series,
    dividendenzahler: series?.isDividendPayer === true,
    koVerschuldung: (s.warningsNumerisch as string[]).some((w) => w.startsWith(KO_VERSCHULDUNG_PRAEFIX)),
    letztesJahr: jahre.length ? jahre[jahre.length - 1] : null,
  };
}

// Dieselben Abschluesse ohne Dividendenfelder: so haette der alte Code
// gerechnet. Der Unterschied zwischen beiden Rechnungen ist der Effekt der
// Korrektur; der Unterschied zum gespeicherten Wert ohne diesen Effekt kommt
// aus neueren FMP-Daten (z. B. ein inzwischen veroeffentlichter
// Jahresabschluss, wie bei Smucker am 24.10.).
export function ohneDividendenfelder(cashflow: FmpErgebnis): FmpErgebnis {
  return {
    ok: cashflow.ok,
    data: arr(cashflow).map((r: Record<string, unknown>) => {
      const { commonDividendsPaid: _a, netDividendsPaid: _b, preferredDividendsPaid: _c, dividendsPaid: _d, ...rest } = r;
      return rest;
    }),
  };
}

// criteria: nur die Fundamental-Eintraege ersetzen, alles andere (Qualitaet
// von Claude, Trend, Krise) bleibt in seiner Reihenfolge. Fundamental steht
// vorn, wie analyse es schreibt.
export function kriterienErsetzen(
  alt: unknown, neuFundamental: Record<string, unknown>[],
): Record<string, unknown>[] {
  const bisher = Array.isArray(alt) ? alt as Record<string, unknown>[] : [];
  return [
    ...neuFundamental.map((k) => ({ dimension: "Fundamental", ...k })),
    ...bisher.filter((k) => k?.dimension !== "Fundamental"),
  ];
}

// Ampelbild der Fundamental-Kriterien als vergleichbarer Schluessel.
function ampelBild(kriterien: Record<string, unknown>[]): string {
  return kriterien
    .map((k) => `${k.name}=${k.ampel}`)
    .sort()
    .join("|");
}

// Muss die Zeile geschrieben werden? Nur wenn sich der gerundete Score oder
// irgendeine Ampel aendert. Sonst bliebe allein das Rundungsrauschen: der
// Gesamtscore entsteht in analyse aus ungerundeten Teilscores, beim
// Nachrechnen sind Q, K und T nur gerundet bekannt - eine unveraenderte Zeile
// koennte so um einen Punkt springen.
export function aendertSich(
  fAlt: number | null, kriterienAlt: unknown, neu: FundamentalErgebnis,
): boolean {
  if (neu.score === null) return false;
  if (fAlt === null || Math.round(neu.score) !== Math.round(fAlt)) return true;
  const altF = (Array.isArray(kriterienAlt) ? kriterienAlt as Record<string, unknown>[] : [])
    .filter((k) => k?.dimension === "Fundamental");
  return ampelBild(altF) !== ampelBild(neu.kriterien);
}

export function gesamtNeu(
  fNeu: number | null, q: number | null, k: number | null, t: number | null,
): number | null {
  const zahl = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return computeTotalWithTrend3(fNeu, zahl(q), zahl(k), zahl(t));
}
