import { callOpenAiCompatible } from "./openai.ts";
import { OPENAI_PRICING } from "./pricing.ts";
import type { LlmToolResult } from "./types.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter ist OpenAI-kompatibel (gleiche /chat/completions-Struktur,
// gleiches Function-Calling-Format) - nutzt den openai.ts-Adapter mit
// anderer Basis-URL, statt Logik zu duplizieren. Modellname (inkl.
// Provider-Praefix, z.B. "anthropic/claude-sonnet-5" oder "openai/gpt-4o")
// kommt 1:1 vom Nutzer.
//
// HTTP-Referer/X-Title sind von OpenRouter empfohlene (nicht zwingende)
// Header zur Identifikation in deren Dashboard - ohne Website-URL fuer
// dieses Projekt bewusst weggelassen statt einen falschen Wert zu raten.
//
// Preistabelle: OPENAI_PRICING aus pricing.ts nur als Best-Effort-Fallback
// fuer den Fall, dass ein Nutzer ein OpenRouter-Modell OHNE Praefix genau
// wie ein bekanntes OpenAI-Modell benennt (z.B. "gpt-4o" statt
// "openai/gpt-4o") - bei den ueblichen praefixierten Namen (die bei
// OpenRouter die Regel sind) greift das nicht, dann ist costUsd 0.
export async function callOpenRouter(apiKey: string, model: string, systemPrompt: string, userPrompt: string): Promise<LlmToolResult> {
  return callOpenAiCompatible(apiKey, model, systemPrompt, userPrompt, {
    baseUrl: OPENROUTER_BASE_URL,
    pricingTable: OPENAI_PRICING,
  });
}
