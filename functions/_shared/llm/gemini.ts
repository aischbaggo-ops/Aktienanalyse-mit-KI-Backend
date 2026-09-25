import { ANALYSIS_TOOL_DESCRIPTION, ANALYSIS_TOOL_NAME, ANALYSIS_TOOL_SCHEMA } from "./prompt.ts";
import { GEMINI_PRICING, lookupCost } from "./pricing.ts";
import type { LlmToolResult } from "./types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Gemini nutzt eine eigene, an JSON Schema angelehnte, aber NICHT
// identische Struktur: Typnamen sind GROSSGESCHRIEBEN ("OBJECT", "STRING",
// "ARRAY", "BOOLEAN" statt "object"/"string"/...), sonst bleiben
// properties/items/required/enum/description strukturell gleich. Rekursiv,
// damit auch verschachtelte Objekte/Arrays (z.B. kriterien[].{name,ampel,
// begruendung}) korrekt uebersetzt werden.
function toGeminiSchema(schema: any): any {
  if (schema === null || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      out.type = value.toUpperCase();
    } else if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (key === "items") {
      out.items = toGeminiSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const GEMINI_TOOL_SCHEMA = toGeminiSchema(ANALYSIS_TOOL_SCHEMA);

export async function callGemini(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<LlmToolResult> {
  const res = await fetch(`${BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      tools: [
        {
          functionDeclarations: [
            { name: ANALYSIS_TOOL_NAME, description: ANALYSIS_TOOL_DESCRIPTION, parameters: GEMINI_TOOL_SCHEMA },
          ],
        },
      ],
      // ANY erzwingt einen Function-Call (statt freien Text) - Gemini-
      // Aequivalent zu Claudes tool_choice/OpenAIs tool_choice:"function".
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [ANALYSIS_TOOL_NAME] },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API ${res.status}: ${text}`);
  }
  const raw = await res.json();

  const parts = raw.candidates?.[0]?.content?.parts || [];
  const functionCallPart = parts.find((p: any) => p.functionCall?.name === ANALYSIS_TOOL_NAME);

  const usage = raw.usageMetadata || {};
  const tokensInput = usage.promptTokenCount || 0;
  const tokensOutput = usage.candidatesTokenCount || 0;

  return {
    toolInput: functionCallPart ? functionCallPart.functionCall.args : null,
    tokensInput,
    tokensOutput,
    costUsd: lookupCost(GEMINI_PRICING, model, tokensInput, tokensOutput),
    rawError: functionCallPart ? undefined : "Kein functionCall mit der erwarteten Analyse in der Gemini-Antwort gefunden.",
  };
}
