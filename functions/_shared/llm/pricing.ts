// $/1M Token, getrennt input/output. Modellname kommt bei openai/gemini/
// openrouter 1:1 vom Nutzer (Freitext) - eine vollstaendige, aktuelle
// Preistabelle fuer JEDES moegliche Modell (insb. OpenRouter: hunderte
// Modelle im Format "anbieter/modell") ist nicht pflegbar. Deshalb bewusst
// nur die gaengigsten Modelle je Anbieter, Stand 2026-09; unbekanntes
// Modell -> costUsd 0 statt einer falschen Schaetzung (siehe lookupCost).
// Bei Bedarf spaeter ergaenzen, wenn ein Nutzer ein fehlendes Modell meldet.

export const CLAUDE_PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-fable-5-1": { in: 10, out: 50 },
};

export const OPENAI_PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "o3": { in: 2, out: 8 },
  "o4-mini": { in: 1.1, out: 4.4 },
};

export const GEMINI_PRICING: Record<string, { in: number; out: number }> = {
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
};

// lookupCost() gilt fuer OpenAI direkt UND fuer OpenRouter, wenn der
// Modellname (nach Abschneiden eines "anbieter/"-Praefixes) zufaellig mit
// einem bekannten OpenAI-Modell uebereinstimmt - reiner Best-Effort.
export function lookupCost(
  table: Record<string, { in: number; out: number }>,
  model: string,
  tokensInput: number,
  tokensOutput: number,
): number {
  const rates = table[model];
  if (!rates) return 0;
  return (tokensInput * rates.in + tokensOutput * rates.out) / 1_000_000;
}
