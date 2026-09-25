export type LlmProvider = "claude" | "openai" | "gemini" | "openrouter";

export const LLM_PROVIDERS: readonly LlmProvider[] = ["claude", "openai", "gemini", "openrouter"];

// Gemeinsame, providerneutrale Rueckgabe eines LLM-Calls - genau das
// Format, das scoring.ts/analyse/index.ts bisher direkt von Claude bekamen
// (siehe alte parseClaudeResponse()). toolInput ist das rohe, vom Modell
// gelieferte strukturierte Objekt (Claude tool_use.input / OpenAI
// tool_calls[0].function.arguments (geparst) / Gemini functionCall.args) -
// null, wenn kein gueltiger strukturierter Aufruf zustande kam.
export interface LlmToolResult {
  toolInput: Record<string, unknown> | null;
  tokensInput: number;
  tokensOutput: number;
  // Best-effort in USD - 0, wenn das Modell nicht in der jeweiligen
  // Preistabelle steht (siehe pricing.ts). Bewusst KEIN Rueckfall auf einen
  // anderen Modellpreis - das waere bei stark unterschiedlichen Anbieter-
  // preisen irrefuehrender als 0.
  costUsd: number;
  // Nur gesetzt, wenn toolInput null ist - Klartext-Grund fuer Logging.
  rawError?: string;
}

export interface CallLlmParams {
  provider: LlmProvider;
  apiKey: string;
  // null nur fuer provider==='claude' erlaubt (Code-Default greift dann,
  // siehe llm/claude.ts) - bei den anderen drei ist model Pflicht, siehe
  // Migration 20260924100000.
  model: string | null;
  systemPrompt: string;
  userPrompt: string;
}
