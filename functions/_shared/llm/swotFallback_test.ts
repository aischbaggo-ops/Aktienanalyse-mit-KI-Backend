// Aufruf (aus dem Repo-Root): deno test functions/_shared/llm/swotFallback_test.ts
// Rein lokal, ohne Netz. Fixtures = echte Rohausgaben aus dem US-Lauf.
import { parseSwotText, recoverSwot } from "./swotFallback.ts";
import { parseAnalysisResult } from "./prompt.ts";
import { RAW_SWOT_EXR, RAW_SWOT_FAST, RAW_SWOT_FE, RAW_SWOT_TEL } from "./swotFallback_fixtures.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

Deno.test("EXR: swot-Text mit fazit und firmenbeschreibung_de -> Objekt plus beide Felder", () => {
  const r = recoverSwot(RAW_SWOT_EXR);
  assert(r.recovered, "gerettet");
  const swot = r.swot as { staerken: string[]; chancen: string[]; risiken: string[] };
  assert(swot.staerken.length === 4 && swot.chancen.length === 3 && swot.risiken.length === 3, "Listen");
  assert(r.extra.fazit?.startsWith("Extra Space Storage zeigt"), "fazit");
  assert(r.extra.firmenbeschreibung_de?.startsWith("Extra Space Storage ist ein"), "firmenbeschreibung_de");
});

Deno.test("FAST: swot-Text mit eingebettetem fazit -> Objekt plus fazit", () => {
  const r = recoverSwot(RAW_SWOT_FAST);
  assert(r.recovered, "gerettet");
  const swot = r.swot as { chancen: string[]; risiken: string[] };
  assert(swot.chancen.length > 0 && swot.risiken.length > 0, "Rueckenwind und Gegenwind vorhanden");
  assert(r.extra.fazit?.startsWith("Fastenal zeigt"), "fazit");
});

Deno.test("TEL: swot-Text mit ueberzaehligem Komma -> Objekt, kein Extra", () => {
  const r = recoverSwot(RAW_SWOT_TEL);
  assert(r.recovered, "gerettet");
  assert((r.swot as { risiken: string[] }).risiken.length === 3, "risiken");
  assert(Object.keys(r.extra).length === 0, "kein Extra");
});

Deno.test("FE-Block: <!-- --> mitten im JSON wird toleriert", () => {
  const r = parseSwotText(RAW_SWOT_FE);
  assert(r.recovered, `gerettet (${r.error})`);
  assert((r.swot as { chancen: string[] }).chancen.length === 3, "chancen");
});

Deno.test("gueltiges swot-Objekt bleibt unveraendert, Unlesbares wird null", () => {
  const obj = { staerken: ["a"], schwaechen: [], chancen: ["c"], risiken: [] };
  const r = recoverSwot(obj);
  assert(!r.recovered && r.swot === obj, "Objekt unveraendert");
  assert(recoverSwot(undefined).swot === null, "fehlt -> null");
  const bad = recoverSwot("keine Daten");
  assert(!bad.recovered && bad.swot === null && !!bad.error, "Text ohne JSON -> null mit Grund");
});

function toolResult(toolInput: Record<string, unknown>) {
  return {
    toolInput,
    rawError: null,
    tokensInput: 0,
    tokensOutput: 0,
    costUsd: 0,
    stopReason: "tool_use",
    responseModel: "claude-sonnet-5",
  } as unknown as Parameters<typeof parseAnalysisResult>[0];
}

Deno.test("parseAnalysisResult: FAST-Form -> swot Objekt, fazit aus dem Text, swotRecovered", () => {
  const p = parseAnalysisResult(toolResult({ kriterien: [], warnings: [], no_go_hart: false, swot: RAW_SWOT_FAST }));
  assert(p.swotRecovered === true, "swotRecovered");
  assert(typeof p.swot === "object" && p.swot !== null && Array.isArray((p.swot as any).chancen), "swot ist Objekt");
  assert(p.fazit?.startsWith("Fastenal zeigt"), "fazit uebernommen");
});

Deno.test("parseAnalysisResult: vorhandenes fazit wird nicht ueberschrieben", () => {
  const p = parseAnalysisResult(toolResult({ kriterien: [], swot: RAW_SWOT_FAST, fazit: "Eigenes Fazit." }));
  assert(p.fazit === "Eigenes Fazit.", "fazit bleibt");
});

Deno.test("parseAnalysisResult: normales swot-Objekt -> swotRecovered false", () => {
  const swot = { staerken: ["a"], schwaechen: ["b"], chancen: ["c"], risiken: ["d"] };
  const p = parseAnalysisResult(toolResult({ kriterien: [], swot, fazit: "x" }));
  assert(p.swotRecovered === false && p.swot === swot, "unveraendert");
});
