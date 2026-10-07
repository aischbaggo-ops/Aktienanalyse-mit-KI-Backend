// Aufruf (aus dem Repo-Root): deno test functions/_shared/llm/embeddedFields_test.ts
// Rein lokal, ohne Netz und ohne DB. Fixtures sind synthetisch: sie bauen die
// drei beobachteten Formen nur strukturell nach (Platzhaltertexte, keine
// FMP-Rohdaten, keine echten Analysetexte).
import { MIN_TEXT_CHARS, rescueEmbeddedFields, validateKriterien } from "./embeddedFields.ts";
import { ANALYSIS_TOOL_SCHEMA, parseAnalysisResult, QUAL_WEIGHTS } from "./prompt.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const OPTS = {
  fieldNames: Object.keys(ANALYSIS_TOOL_SCHEMA.properties),
  criteriaNames: Object.keys(QUAL_WEIGHTS),
};
const AMPELN = ["gruen", "gelb", "rot", "grau"];

function kriterien20(): any[] {
  return OPTS.criteriaNames.map((name, i) => ({ name, ampel: AMPELN[i % 3], begruendung: `Testbegruendung ${i}` }));
}
const SWOT = { staerken: ["a"], schwaechen: ["b"], chancen: ["c"], risiken: ["d"] };
const J = (v: unknown) => JSON.stringify(v);
const prose = (min = 300) => "Platzhaltertext fuer den Test. ".repeat(Math.ceil(min / 30)).trim();
const DESC = "Platzhalter-Beschreibung des Unternehmens, nur fuer Tests, " + "ausreichend lang. ".repeat(8);
const rescue = (toolInput: Record<string, unknown>) => rescueEmbeddedFields(toolInput, OPTS);
const parse = (toolInput: Record<string, unknown>) =>
  parseAnalysisResult({ toolInput, tokensInput: 0, tokensOutput: 0, costUsd: 0 });

// Form 1: direkte Tags im fazit, kriterien fehlt (AAPL 05.10. 08:12)
const form1 = () => ({
  fazit: `${prose()}</fazit>\n<firmenbeschreibung_de">${DESC}</firmenbeschreibung_de>\n<kriterien>${J(kriterien20())}</kriterien>\n` +
    `<warnings>["w1"]</warnings>\n<no_go_hart>false</no_go_hart>\n<swot>${J(SWOT)}</swot>\n</invoke>\n`,
});
// Form 2: kriterien korrekt, <parameter>-Reste ohne schliessendes Tag am Ende (MSFT/DIS)
const form2 = () => ({
  kriterien: kriterien20(), warnings: ["w"], swot: SWOT,
  fazit: `${prose()}</fazit>\n<parameter name="firmenbeschreibung_de">${DESC}</parameter>\n<parameter name="no_go_hart">false`,
});
// Form 3: </fazit> und </invoke>, <kriterien"> mit Anfuehrungszeichen (AAPL 05.10. ca. 09:40)
const form3 = () => ({
  fazit: `${prose()}</fazit>\n<firmenbeschreibung_de>${DESC}</firmenbeschreibung_de>\n<kriterien">${J(kriterien20())}</kriterien>\n` +
    `<no_go_hart>false</no_go_hart>\n<swot>${J(SWOT)}</swot>\n<warnings>[]</warnings>\n</invoke>`,
});

Deno.test("Form 1: alle Felder gerettet, fazit abgeschnitten", () => {
  const r = rescue(form1());
  assert(r.touched, "touched");
  assert(r.markers.includes("</fazit>") && r.markers.includes("</invoke>") && r.markers.includes("<kriterien"), "Marker");
  assert(Object.keys(r.adopted).sort().join() === "firmenbeschreibung_de,kriterien,no_go_hart,swot,warnings", "adopted");
  assert((r.adopted.kriterien as any[]).length === 20, "20 Kriterien");
  assert(r.cleanText.fazit === prose(), "fazit bis zum ersten Marker");
  assert(r.conflicts.length === 0 && r.rejected.length === 0, "keine Konflikte/Ablehnungen");
  assert(r.reasons.includes("embedded_recovered"), "Grund");
  const p = parse(form1());
  assert(typeof p.scoreQualitaet === "number" && p.qualitaetKriterien.length === 20, "Score aus geretteten Kriterien");
  assert(p.fazit === prose() && !String(p.fazit).includes("<"), "fazit sauber");
  assert(p.firmenbeschreibungDe === DESC.trim(), "Beschreibung gerettet");
  assert(p.noGoHart === false && p.swot !== null && p.warnings.length === 1, "Rest gerettet");
});

Deno.test("Form 2: kriterien vorhanden, Beschreibung und no_go_hart aus <parameter>-Resten", () => {
  const r = rescue(form2());
  assert(Object.keys(r.adopted).sort().join() === "firmenbeschreibung_de,no_go_hart", "nur fehlende Felder");
  assert(r.cleanText.fazit === prose(), "fazit abgeschnitten");
  assert(r.conflicts.length === 0, "kein Konflikt");
  const p = parse(form2());
  assert(p.firmenbeschreibungDe === DESC.trim(), "Beschreibung hat Vorrang vor dem FMP-Fallback");
  assert(!String(p.fazit).includes("<parameter") && p.fazit === prose(), "fazit ohne Reste");
  assert(typeof p.scoreQualitaet === "number", "Score unveraendert berechenbar");
});

Deno.test("Form 3: <kriterien\"> mit Anfuehrungszeichen wird gerettet", () => {
  const r = rescue(form3());
  assert((r.adopted.kriterien as any[])?.length === 20, "kriterien gerettet");
  assert(r.cleanText.fazit === prose(), "fazit abgeschnitten");
  assert(parse(form3()).scoreQualitaet !== null, "Score vorhanden");
});

Deno.test("Form 3b: Marker, aber nichts rettbar: nichts uebernommen, Zeile bleibt ohne Score", () => {
  const input = { fazit: `${prose()}</fazit>\n</invoke>\n` };
  const r = rescue(input);
  assert(r.touched && Object.keys(r.adopted).length === 0, "nichts adoptiert");
  assert(r.reasons.includes("nothing_adopted"), "Grund nothing_adopted");
  const p = parse(input);
  assert(p.scoreQualitaet === null && p.qualitaetKriterien.length === 0, "kein Score");
  assert(p.fazit === prose(), "Anzeigetext trotzdem abgeschnitten");
});

Deno.test("Toleranz: Leerzeichen, einfache Anfuehrungszeichen, fehlende schliessende Tags", () => {
  const input = {
    fazit: `${prose()}</fazit>\n< kriterien >${J(kriterien20())}\n<warnings>["x"]\n<parameter name='no_go_hart'>true`,
  };
  const r = rescue(input);
  assert((r.adopted.kriterien as any[])?.length === 20, "kriterien trotz Leerzeichen und ohne Schliess-Tag");
  assert(JSON.stringify(r.adopted.warnings) === '["x"]', "warnings");
  assert(r.adopted.no_go_hart === true, "no_go_hart mit einfachen Anfuehrungszeichen");
});

Deno.test("no_go_hart: fehlt die Property und steht true eingebettet, gilt true (mit Grund)", () => {
  const input = { kriterien: kriterien20(), fazit: `${prose()}</fazit>\n<no_go_hart>true</no_go_hart>` };
  const r = rescue(input);
  assert(r.adopted.no_go_hart === true, "true uebernommen");
  assert(r.reasons.includes("no_go_hart_true_from_embedded"), "Event-Grund");
  assert(parse(input).noGoHart === true, "noGoHart true");
});

Deno.test("no_go_hart: Default false greift nur, wenn auch eingebettet nichts steht", () => {
  const input = { kriterien: kriterien20(), fazit: `${prose()}</fazit>\n<warnings>[]</warnings>` };
  assert(rescue(input).adopted.no_go_hart === undefined, "nichts eingebettet");
  assert(parse(input).noGoHart === false, "Default false");
});

Deno.test("Vorhandene gueltige Felder werden nie ueberschrieben, Konflikt mit beiden Werten", () => {
  const input = {
    kriterien: kriterien20(), no_go_hart: false, firmenbeschreibung_de: DESC,
    fazit: `${prose()}</fazit>\n<no_go_hart>true</no_go_hart>\n<firmenbeschreibung_de>Anderer Text</firmenbeschreibung_de>`,
  };
  const r = rescue(input);
  assert(Object.keys(r.adopted).length === 0, "nichts uebernommen");
  const fields = r.conflicts.map((c) => c.field).sort().join();
  assert(fields === "firmenbeschreibung_de,no_go_hart", "beide Konflikte");
  const ng = r.conflicts.find((c) => c.field === "no_go_hart")!;
  assert(ng.existing === "false" && ng.embedded === "true", "beide Werte im Konflikt");
  assert(r.reasons.includes("embedded_conflict"), "Grund");
  const p = parse(input);
  assert(p.noGoHart === false && p.firmenbeschreibungDe === DESC, "vorhandene Werte gewinnen");
});

Deno.test("fazit zu kurz nach dem Abschneiden: nicht kuerzen, nur Event-Grund", () => {
  const short = "Kurz.";
  assert(short.length < MIN_TEXT_CHARS.fazit, "Fixture ist kuerzer als die Mindestlaenge");
  const input = { kriterien: kriterien20(), fazit: `${short}</fazit>\n<no_go_hart>false</no_go_hart>` };
  const r = rescue(input);
  assert(r.cleanText.fazit === undefined && r.reasons.includes("fazit_too_short_after_cut"), "kein Schnitt");
  assert(parse(input).fazit === input.fazit, "Originaltext bleibt unveraendert");
});

Deno.test("Negativ: ungueltige kriterien werden nicht uebernommen, auch nichts anderes", () => {
  const good = kriterien20();
  const variants: Record<string, any[]> = {
    "19 Eintraege": good.slice(0, 19),
    "unbekannter Name": good.map((k, i) => (i === 3 ? { ...k, name: "Erfundenes Kriterium" } : k)),
    "ungueltige ampel": good.map((k, i) => (i === 5 ? { ...k, ampel: "GRUEN" } : k)),
    "leere begruendung": good.map((k, i) => (i === 7 ? { ...k, begruendung: "  " } : k)),
    "doppelter Name": good.map((k, i) => (i === 9 ? { ...k, name: good[0].name } : k)),
  };
  for (const [label, k] of Object.entries(variants)) {
    const input = { fazit: `${prose()}</fazit>\n<firmenbeschreibung_de>${DESC}</firmenbeschreibung_de>\n<kriterien>${J(k)}</kriterien>` };
    const r = rescue(input);
    assert(Object.keys(r.adopted).length === 0, `${label}: nichts uebernommen`);
    assert(r.reasons.includes("kriterien_invalid") && r.reasons.includes("embedded_discarded"), `${label}: Gruende`);
    const p = parse(input);
    assert(p.scoreQualitaet === null && p.firmenbeschreibungDe === null, `${label}: kein Score, keine Beschreibung`);
  }
  const broken = { fazit: `${prose()}</fazit>\n<kriterien>[{"name": "x", </kriterien>` };
  const rb = rescue(broken);
  assert(Object.keys(rb.adopted).length === 0 && rb.reasons.includes("kriterien_invalid"), "kaputtes JSON");
  assert(validateKriterien(good, OPTS.criteriaNames).ok === true, "Gegenprobe: gueltige Liste ist ok");
});

Deno.test("Marker im Feld firmenbeschreibung_de: Text wird abgeschnitten", () => {
  const input = { kriterien: kriterien20(), firmenbeschreibung_de: `${DESC}</invoke>\n`, fazit: prose() };
  const r = rescue(input);
  assert(r.touched && r.cleanText.firmenbeschreibung_de === DESC.trim(), "Beschreibung bereinigt");
  assert(r.cleanText.fazit === undefined, "fazit unberuehrt");
});

Deno.test("Ohne Marker: nichts beruehrt, Parser verhaelt sich wie zuvor", () => {
  const input = { kriterien: kriterien20(), warnings: ["w"], no_go_hart: false, swot: SWOT, fazit: prose(), firmenbeschreibung_de: DESC };
  const r = rescue(input);
  assert(!r.touched && r.markers.length === 0 && Object.keys(r.adopted).length === 0, "unberuehrt");
  const p = parse(input);
  assert(p.fazit === prose() && p.firmenbeschreibungDe === DESC && typeof p.scoreQualitaet === "number", "unveraendert");
  assert(rescueEmbeddedFields(null, OPTS).touched === false, "null-Eingabe");
});
