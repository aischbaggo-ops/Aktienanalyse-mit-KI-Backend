import { callClaude } from "./claude.ts";
import { callOpenAI } from "./openai.ts";
import { callOpenRouter } from "./openrouter.ts";
import { callGemini } from "./gemini.ts";
import type { CallLlmParams, LlmToolResult } from "./types.ts";

export * from "./types.ts";
export { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisResult, QUAL_WEIGHTS } from "./prompt.ts";

// Einheitlicher Einstiegspunkt fuer alle vier Anbieter - analyse/index.ts
// (und kuenftig admin-chat, falls das je mehrere Anbieter braucht) ruft nur
// noch das hier auf, kennt die Anbieter-Details nicht mehr direkt.
export async function callLLM(params: CallLlmParams): Promise<LlmToolResult> {
  const { provider, apiKey, model, systemPrompt, userPrompt } = params;

  switch (provider) {
    case "claude":
      return callClaude(apiKey, model, systemPrompt, userPrompt);
    case "openai":
      if (!model) throw new Error("Modellname fehlt (Pflichtfeld fuer OpenAI).");
      return callOpenAI(apiKey, model, systemPrompt, userPrompt);
    case "openrouter":
      if (!model) throw new Error("Modellname fehlt (Pflichtfeld fuer OpenRouter).");
      return callOpenRouter(apiKey, model, systemPrompt, userPrompt);
    case "gemini":
      if (!model) throw new Error("Modellname fehlt (Pflichtfeld fuer Gemini).");
      return callGemini(apiKey, model, systemPrompt, userPrompt);
    default: {
      // Erschoepfende switch-Pruefung - bei einem neuen LlmProvider-Wert
      // faellt das hier zur Compile-Zeit auf, nicht erst zur Laufzeit.
      const exhaustive: never = provider;
      throw new Error(`Unbekannter LLM-Anbieter: ${exhaustive}`);
    }
  }
}
