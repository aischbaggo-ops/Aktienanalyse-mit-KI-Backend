import { ANALYSIS_TOOL_DESCRIPTION, ANALYSIS_TOOL_NAME, ANALYSIS_TOOL_SCHEMA } from "./prompt.ts";
import { CLAUDE_PRICING } from "./pricing.ts";
import type { LlmToolResult } from "./types.ts";

// Standard-Claude-Modell, wenn der Nutzer keins hinterlegt hat (Bestehende
// Nutzer, deren user_llm_keys.model NULL ist - siehe Migration
// 20260924100000). Bewusst weiterhin "claude-sonnet-5", NICHT auf ein
// anderes Modell umgestellt - "Bestandsverhalten nicht brechen" war
// explizite Vorgabe fuer dieses Feature.
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";

// Ruft die echte Anthropic Messages API direkt per fetch auf (kein SDK-
// Import noetig, funktioniert zuverlaessig in Deno) - identisch zur
// bisherigen callClaude()-Implementierung, nur um das providerneutrale
// LlmToolResult-Format herum gewrappt.
//
// tool_choice erzwingt den Aufruf des Analyse-Tools - Claude liefert die
// Analyse damit als strukturiertes, schema-validiertes Objekt statt als
// freien JSON-Text. Das verhindert Parse-Fehler durch unescapte
// Anführungszeichen o.ae. in generierten Freitextfeldern.
export async function callClaude(
  apiKey: string,
  model: string | null,
  systemPrompt: string,
  userPrompt: string,
): Promise<LlmToolResult> {
  const usedModel = model || DEFAULT_CLAUDE_MODEL;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: usedModel,
      max_tokens: 6000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: [{ name: ANALYSIS_TOOL_NAME, description: ANALYSIS_TOOL_DESCRIPTION, input_schema: ANALYSIS_TOOL_SCHEMA }],
      tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text}`);
  }
  const raw = await res.json();

  const toolBlock = (raw.content || []).find(
    (c: any) => c.type === "tool_use" && c.name === ANALYSIS_TOOL_NAME,
  );
  const usage = raw.usage || {};
  const tokensInput = usage.input_tokens || 0;
  const tokensOutput = usage.output_tokens || 0;
  const responseModel = raw.model || usedModel;
  // Bewusst NICHT die generische lookupCost()-0-Fallback-Logik (siehe
  // pricing.ts) - fuer Claude gab es schon immer einen Naeherungs-Fallback
  // auf die Sonnet-5-Rate, falls raw.model nicht exakt einem Tabellen-
  // Eintrag entspricht (z.B. ein datiertes Snapshot-Modell). Das bleibt
  // hier erhalten ("Bestandsverhalten nicht brechen").
  const rates = CLAUDE_PRICING[responseModel] || CLAUDE_PRICING[DEFAULT_CLAUDE_MODEL];
  const costUsd = (tokensInput * rates.in + tokensOutput * rates.out) / 1_000_000;

  return {
    toolInput: toolBlock ? toolBlock.input : null,
    tokensInput,
    tokensOutput,
    costUsd,
    rawError: toolBlock ? undefined : "Kein tool_use-Block mit der erwarteten Analyse in der Claude-Antwort gefunden.",
  };
}
