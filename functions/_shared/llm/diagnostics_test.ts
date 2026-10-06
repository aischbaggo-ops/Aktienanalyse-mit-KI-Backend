// Aufruf (aus dem Repo-Root): deno test functions/_shared/llm/diagnostics_test.ts
// Rein lokal, ohne Netz und ohne DB. Fixtures sind synthetisch nachgebaute
// Formen der drei beobachteten Faelle (AAPL direkte Tags, MSFT/DIS
// teil-eingebettete <parameter>-Reste, sauberer Lauf).
import {
  detectLlmAnomaly,
  findEmbeddedMarkers,
  MAX_TOOL_INPUT_BYTES,
  missingToolFields,
  truncateUtf8,
} from "./diagnostics.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const KRIT = Array.from({ length: 20 }, (_, i) => ({ name: `K${i}`, ampel: "gruen", begruendung: "ok" }));
const SWOT = { staerken: ["a"], schwaechen: ["b"], chancen: ["c"], risiken: ["d"] };

const base = {
  ticker: "TEST",
  provider: "claude",
  callType: "qualitaet-analyse",
  model: "claude-sonnet-5",
  stopReason: "tool_use",
  missingScoreParts: [] as string[],
};

Deno.test("sauberer Lauf: kein Event", () => {
  const toolInput = {
    kriterien: KRIT, warnings: [], no_go_hart: false, swot: SWOT,
    fazit: "Sauberer Fliesstext.", firmenbeschreibung_de: "Beschreibung.",
  };
  assert(detectLlmAnomaly({ ...base, toolInput, scoreQualitaet: 80 }) === null, "erwartet null");
  assert(missingToolFields(toolInput).length === 0, "keine fehlenden Felder");
});

Deno.test("AAPL-Form: direkte Tags im fazit, kriterien fehlt", () => {
  const toolInput = {
    fazit: `Text.</fazit>\n<firmenbeschreibung_de">Beschreibung</firmenbeschreibung_de>\n<kriterien>${
      JSON.stringify(KRIT)
    }</kriterien>\n<warnings>[]</warnings>\n<no_go_hart>false</no_go_hart>\n<swot>${JSON.stringify(SWOT)}</swot>\n</invoke>\n`,
  };
  const a = detectLlmAnomaly({ ...base, toolInput, scoreQualitaet: null, missingScoreParts: ["Qualitaet"] });
  assert(a !== null, "Event erwartet");
  const d = a!.details as Record<string, unknown>;
  assert((a!.reasons).join() === "score_qualitaet_null,embedded_markers", "beide Gruende");
  assert(["</invoke>", "</fazit>", "<kriterien", "<swot", "<warnings"].every((m) => (d.markers as string[]).includes(m)), "Marker (auch <kriterien\" und </feld>)");
  assert((d.marker_fields as string[]).join() === "fazit", "Feld fazit");
  assert((d.missing_tool_fields as string[]).join() === "kriterien,warnings,no_go_hart,swot,firmenbeschreibung_de", "fehlende Felder");
  assert(d.model === "claude-sonnet-5" && d.stop_reason === "tool_use" && d.ticker === "TEST", "Metadaten");
  assert(d.tool_input !== undefined && d.tool_input_truncated === undefined, "toolInput unverkuerzt");
});

Deno.test("MSFT/DIS-Form: Reste im fazit, kriterien korrekt vorhanden", () => {
  const toolInput = {
    kriterien: KRIT, warnings: ["w"], no_go_hart: false, swot: SWOT,
    fazit: 'Text.</fazit>\n<parameter name="firmenbeschreibung_de">Beschreibung</parameter>\n<parameter name="no_go_hart">false',
  };
  const a = detectLlmAnomaly({ ...base, toolInput, scoreQualitaet: 93 });
  assert(a !== null, "Event trotz Score erwartet");
  assert(a!.reasons.join() === "embedded_markers", "nur Marker-Grund");
  assert((a!.details.markers as string[]).join() === "<parameter,</fazit>", "Marker <parameter und </fazit>");
});

Deno.test("Marker in verschachteltem String wird mit Pfad gemeldet", () => {
  const hits = findEmbeddedMarkers({ kriterien: [{ begruendung: "ok" }, { begruendung: "x <swot> y" }] });
  assert(hits.markers.join() === "<swot", "Marker");
  assert(hits.fields.join() === "kriterien[1].begruendung", "Pfad");
});

Deno.test("kein toolInput (Parse-Fehler): Event mit allen Feldern fehlend", () => {
  const a = detectLlmAnomaly({
    ...base, toolInput: null, scoreQualitaet: null, parseError: "Kein tool_use-Block", missingScoreParts: ["Qualitaet"],
  });
  assert(a !== null && a.details.tool_input === null, "tool_input null");
  assert((a!.details.missing_tool_fields as string[]).length === 6, "6 Pflichtfelder fehlen");
});

Deno.test("toolInput > 20 KB wird auf 20 KB (UTF-8) begrenzt", () => {
  const big = { fazit: "ä".repeat(30_000) + "</fazit>" };
  const a = detectLlmAnomaly({ ...base, toolInput: big, scoreQualitaet: null });
  const d = a!.details as Record<string, unknown>;
  assert(d.tool_input_truncated === true && d.tool_input === undefined, "verkuerzt, nicht als Objekt");
  assert(new TextEncoder().encode(d.tool_input_json as string).length <= MAX_TOOL_INPUT_BYTES, "<= 20 KB");
  assert((d.tool_input_bytes as number) > MAX_TOOL_INPUT_BYTES, "Originalgroesse vermerkt");
  assert(truncateUtf8("abc", 10).truncated === false, "kurzer Text unveraendert");
});

Deno.test("Event enthaelt den Befund des Fangnetzes (uebernommen, Konflikt mit beiden Werten)", () => {
  const recovery = {
    touched: true, markers: ["</fazit>"], adopted: { firmenbeschreibung_de: "x" }, cleanText: { fazit: "Sauber." },
    conflicts: [{ field: "no_go_hart", existing: "false", embedded: "true" }],
    rejected: [], reasons: ["embedded_recovered", "embedded_conflict"],
  };
  const toolInput = { kriterien: [], fazit: "Text.</fazit>" };
  const a = detectLlmAnomaly({ ...base, toolInput, scoreQualitaet: 80, recovery });
  assert(a !== null, "Event");
  assert(a!.reasons.includes("embedded_recovered") && a!.reasons.includes("embedded_conflict"), "Gruende uebernommen");
  const rec = a!.details.recovery as Record<string, any>;
  assert(rec.adopted_fields.join() === "firmenbeschreibung_de" && rec.fazit_cut === true, "uebernommene Felder");
  assert(rec.conflicts[0].existing === "false" && rec.conflicts[0].embedded === "true", "beide Werte");
});
