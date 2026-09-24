import { ANALYSIS_TOOL_DESCRIPTION, ANALYSIS_TOOL_NAME, ANALYSIS_TOOL_SCHEMA } from "./prompt.ts";
import { OPENAI_PRICING, lookupCost } from "./pricing.ts";
import type { LlmToolResult } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// OpenAI Chat Completions API mit erzwungenem Function-Call fuer
// strukturierten Output. baseUrl ist parametrisiert, damit openrouter.ts
// diesen Adapter mit anderer Basis-URL wiederverwenden kann (OpenRouter ist
// OpenAI-kompatibel) - siehe dort. pricingTable ebenfalls parametrisiert,
// da OpenRouter eigene Modellnamen/Praefixe nutzt.
export async function callOpenAiCompatible(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options?: { baseUrl?: string; pricingTable?: Record<string, { in: number; out: number }>; extraHeaders?: Record<string, string> },
): Promise<LlmToolResult> {
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  const pricingTable = options?.pricingTable ?? OPENAI_PRICING;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options?.extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: [
        {
          type: "function",
          function: { name: ANALYSIS_TOOL_NAME, description: ANALYSIS_TOOL_DESCRIPTION, parameters: ANALYSIS_TOOL_SCHEMA },
        },
      ],
      tool_choice: { type: "function", function: { name: ANALYSIS_TOOL_NAME } },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${baseUrl} ${res.status}: ${text}`);
  }
  const raw = await res.json();

  const toolCall = raw.choices?.[0]?.message?.tool_calls?.find(
    (c: any) => c.function?.name === ANALYSIS_TOOL_NAME,
  );

  let toolInput: Record<string, unknown> | null = null;
  let rawError: string | undefined;
  if (!toolCall) {
    rawError = "Kein tool_call mit der erwarteten Analyse in der Antwort gefunden.";
  } else {
    try {
      // arguments kommt als JSON-STRING zurueck (anders als bei Claude, wo
      // tool_use.input bereits ein geparstes Objekt ist) - muss explizit
      // geparst werden, siehe OpenAI Function-Calling-Doku.
      toolInput = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      rawError = `tool_call.arguments war kein gueltiges JSON: ${(e as Error).message}`;
    }
  }

  const usage = raw.usage || {};
  const tokensInput = usage.prompt_tokens || 0;
  const tokensOutput = usage.completion_tokens || 0;
  const responseModel = raw.model || model;

  return {
    toolInput,
    tokensInput,
    tokensOutput,
    costUsd: lookupCost(pricingTable, responseModel, tokensInput, tokensOutput),
    rawError,
  };
}

export async function callOpenAI(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<LlmToolResult> {
  return callOpenAiCompatible(apiKey, model, systemPrompt, userPrompt);
}
