import { findeKollisionen, istPunktlos, zwillingeFuer, type Konstituent } from "./kollision.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FEHLGESCHLAGEN: " + msg);
}

// Ausschnitt aus index_constituents, so wie er am 23.10.2026 dort steht.
const LISTE: Konstituent[] = [
  { ticker: "ADS.DE", company_name: "adidas AG" },
  { ticker: "ALV.DE", company_name: "Allianz SE" },
  { ticker: "HEI.DE", company_name: "Heidelberg Materials AG" },
  { ticker: "MRK.DE", company_name: "Merck KGaA" },
  { ticker: "SAP.DE", company_name: "SAP SE" },
  { ticker: "NEM.DE", company_name: "Nemetschek SE" },
  { ticker: "AIR.PA", company_name: "Airbus SE" },
  { ticker: "VOW3.DE", company_name: "Volkswagen AG" },
];

Deno.test("Punktlose Kuerzel werden geprueft, Gattungen nicht", () => {
  assert(istPunktlos("ADS"), "ADS");
  assert(!istPunktlos("ADS.DE"), "ADS.DE");
  // BRK.B und BRK-B sind Gattungen desselben Papiers, keine Verwechslung.
  assert(!istPunktlos("BRK.B"), "BRK.B");
  assert(!istPunktlos("BRK-B"), "BRK-B");
});

Deno.test("Der Zwilling wird ueber das Praefix gefunden, .DE hat Vorrang", () => {
  assert(zwillingeFuer("ADS", LISTE)[0].ticker === "ADS.DE", "ADS -> ADS.DE");
  assert(zwillingeFuer("AIR", LISTE)[0].ticker === "AIR.PA", "AIR -> AIR.PA (Airbus notiert in Paris)");
  assert(zwillingeFuer("MSFT", LISTE).length === 0, "kein Zwilling fuer MSFT");
  // Kein Praefix-Treffer ohne Punkt: VOW3 darf nicht ueber VOW gefunden
  // werden, sonst warnte jede Teilzeichenkette.
  assert(zwillingeFuer("VOW", LISTE).length === 0, "VOW ist nicht VOW3.DE");
  const doppelt: Konstituent[] = [
    { ticker: "XX.PA", company_name: "Paris" },
    { ticker: "XX.DE", company_name: "Frankfurt" },
  ];
  assert(zwillingeFuer("XX", doppelt)[0].ticker === "XX.DE", ".DE zuerst");
});

Deno.test("Die 24 Faelle vom 21.10. werden erkannt", () => {
  const eingaben = ["ADS", "ALV", "HEI", "MRK", "NEM", "AIR"];
  const k = findeKollisionen(eingaben, LISTE, {
    ADS: { name: "Bread Financial Holdings, Inc.", currency: "USD", country: "US", exchange: "NYSE" },
    ALV: { name: "Autoliv, Inc.", currency: "USD", country: "US", exchange: "NYSE" },
  });
  assert(k.length === 6, `sechs Warnungen, waren ${k.length}`);
  const ads = k.find((x) => x.eingabe === "ADS")!;
  assert(ads.vorschlag === "ADS.DE" && ads.vorschlag_name === "adidas AG", "Vorschlag ADS.DE");
  assert(ads.meldung.includes("Bread Financial"), "gefundene Firma steht in der Meldung");
  assert(ads.meldung.includes("USD"), "Waehrung steht in der Meldung");
  assert(ads.meldung.includes("adidas AG"), "gemeinte Firma steht in der Meldung");
});

Deno.test("Ohne FMP-Profil bleibt die Meldung brauchbar", () => {
  const [k] = findeKollisionen(["HEI"], LISTE);
  assert(k.gefunden === null && k.waehrung === null, "keine Profildaten");
  assert(k.meldung.includes("HEI.DE") && k.meldung.includes("Heidelberg"), `Meldung: ${k.meldung}`);
});

Deno.test("SAP wird ebenfalls gemeldet, obwohl es dieselbe Firma ist", () => {
  // Bewusst: ein Namensvergleich wuerde SAP durchlassen, aber auch
  // "Merck & Co." gegen "Merck KGaA" - nach jeder Normalisierung identisch,
  // in Wahrheit zwei Unternehmen. Lieber eine Warnung zu viel.
  const k = findeKollisionen(["SAP"], LISTE, {
    SAP: { name: "SAP SE", currency: "USD", country: "DE", exchange: "NYSE" },
  });
  assert(k.length === 1 && k[0].vorschlag === "SAP.DE", "SAP wird gemeldet");
});

Deno.test("US-Ticker ohne deutschen Zwilling bleiben unberuehrt", () => {
  const k = findeKollisionen(["MSFT", "NVDA", "KO", "BRK.B"], LISTE);
  assert(k.length === 0, `keine Warnung, waren ${k.length}`);
});

Deno.test("Gross- und Kleinschreibung sowie Leerzeichen stoeren nicht", () => {
  const k = findeKollisionen([" ads ", "alv"], LISTE);
  assert(k.length === 2, "beide erkannt");
  assert(k[0].eingabe === "ADS", "Eingabe normalisiert");
});
