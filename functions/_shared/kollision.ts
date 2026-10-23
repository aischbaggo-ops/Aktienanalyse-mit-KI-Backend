// ---------------------------------------------------------------------------
// TICKER-KOLLISIONEN: deutsches Kuerzel ohne Boersenzusatz
// ---------------------------------------------------------------------------
// Am 21.10.2026 wurden die DAX-40- und MDAX-50-Listen ohne ".DE" in "Ticker
// erkennen" eingefuegt. validate-tickers liess 24 davon durch, weil FMP zu
// jedem ein Profil liefert - nur eben das eines gleichnamigen US-Papiers:
//
//   ADS -> Bread Financial Holdings (gemeint: Adidas)
//   ALV -> Autoliv              (gemeint: Allianz)
//   HEI -> HEICO Corporation    (gemeint: Heidelberg Materials)
//   MRK -> Merck & Co.          (gemeint: Merck KGaA)
//
// 14 fremde Firmen landeten mit vollstaendiger Analyse in der Datenbank und
// mussten geloescht werden; die Ergebnisse sahen dabei voellig plausibel aus.
// Genau das macht die Fehlerklasse gefaehrlich: sie faellt nicht auf.
//
// Die Pruefung hier ist bewusst stumpf: Gibt es zu einem punktlosen Kuerzel
// einen Eintrag MIT Endung in index_constituents, wird gewarnt - IMMER, auch
// wenn die Namen uebereinstimmen. Ein Namensvergleich waere die elegantere
// Regel, scheitert aber genau an den heikelsten Faellen: "Merck & Co." und
// "Merck KGaA" sind nach jeder brauchbaren Normalisierung identisch, sind
// aber zwei verschiedene Unternehmen. Lieber eine Warnung zu viel (SAP, das
// in New York dieselbe Firma ist) als eine zu wenig.
//
// Die Warnung blockiert nicht. Sie nimmt den Kandidaten nur aus der
// Vorauswahl und bietet die Schreibweise mit Endung an.
// ---------------------------------------------------------------------------

export interface Konstituent {
  ticker: string;
  company_name: string | null;
}

// Was FMP zum eingegebenen Kuerzel gefunden hat. Reicht dem Nutzer, um die
// Verwechslung auf einen Blick zu erkennen.
export interface FmpTreffer {
  name: string | null;
  currency: string | null;
  country: string | null;
  exchange: string | null;
}

export interface Kollision {
  eingabe: string;
  gefunden: string | null;
  waehrung: string | null;
  land: string | null;
  vorschlag: string;
  vorschlag_name: string | null;
  meldung: string;
}

// Ein Kuerzel ohne Punkt und ohne Bindestrich. Gattungen wie BRK.B oder
// BRK-B sind bereits eindeutig und werden nicht geprueft.
export function istPunktlos(symbol: string): boolean {
  return !symbol.includes(".") && !symbol.includes("-");
}

// Alle Index-Eintraege, die mit "<EINGABE>." beginnen. Mehrere sind moeglich
// (dasselbe Kuerzel an zwei Boersen); ".DE" hat Vorrang, sonst alphabetisch.
export function zwillingeFuer(eingabe: string, konstituenten: Konstituent[]): Konstituent[] {
  const praefix = eingabe.trim().toUpperCase() + ".";
  return konstituenten
    .filter((k) => k.ticker.toUpperCase().startsWith(praefix))
    .sort((a, b) => {
      const da = a.ticker.toUpperCase().endsWith(".DE") ? 0 : 1;
      const db = b.ticker.toUpperCase().endsWith(".DE") ? 0 : 1;
      return da !== db ? da - db : a.ticker.localeCompare(b.ticker);
    });
}

function meldungFuer(k: Kollision): string {
  const herkunft = [k.waehrung, k.land].filter(Boolean).join(", ");
  const gefunden = k.gefunden
    ? `${k.eingabe} ist ${k.gefunden}${herkunft ? ` (${herkunft})` : ""}`
    : `${k.eingabe} ist nicht eindeutig`;
  const ziel = k.vorschlag_name ? `${k.vorschlag} - ${k.vorschlag_name}` : k.vorschlag;
  return `${gefunden}. Gemeint war vermutlich ${ziel}.`;
}

// Prueft eine Liste bereits von FMP bestaetigter Kuerzel gegen die
// Indexlisten. `treffer` sind die FMP-Profildaten zur EINGABE (nicht zum
// Vorschlag) und duerfen fehlen - dann steht nur der Vorschlag in der
// Meldung.
export function findeKollisionen(
  eingaben: string[],
  konstituenten: Konstituent[],
  treffer: Record<string, FmpTreffer> = {},
): Kollision[] {
  const raus: Kollision[] = [];
  for (const roh of eingaben) {
    const eingabe = roh.trim().toUpperCase();
    if (!eingabe || !istPunktlos(eingabe)) continue;
    const [zwilling] = zwillingeFuer(eingabe, konstituenten);
    if (!zwilling) continue;
    const t = treffer[eingabe] ?? treffer[roh];
    const k: Kollision = {
      eingabe,
      gefunden: t?.name ?? null,
      waehrung: t?.currency ?? null,
      land: t?.country ?? null,
      vorschlag: zwilling.ticker.toUpperCase(),
      vorschlag_name: zwilling.company_name,
      meldung: "",
    };
    k.meldung = meldungFuer(k);
    raus.push(k);
  }
  return raus;
}
