import type { LlmProvider } from "./types.ts";

// Leichte, kostenlose Pruefung, ob ein neu eingegebener API-Key beim
// jeweiligen Anbieter gueltig ist, BEVOR er verschluesselt gespeichert
// wird - verhindert, dass ein kaputter Key erst beim naechsten echten
// Analyse-Lauf auffaellt. Jeder Call ist ein reiner Metadaten-Abruf
// (Modell-Liste bzw. Key-Info), kostet keine Tokens.
//
// Live verifiziert (2026-09-25) welcher HTTP-Status einen UNGUELTIGEN Key
// tatsaechlich meldet (nicht aus Trainingsdaten geraten):
// - Claude:     GET /v1/models            -> 401 bei ungueltigem Key
// - OpenAI:     GET /v1/models            -> 401 bei ungueltigem Key
// - OpenRouter: GET /api/v1/auth/key      -> 401 bei ungueltigem Key
//               (nicht /api/v1/models - der ist oeffentlich ohne Auth
//               erreichbar und daher zur Validierung ungeeignet)
// - Gemini:     GET /v1beta/models?key=.. -> 400 (INVALID_ARGUMENT /
//               API_KEY_INVALID) bei ungueltigem Key, NICHT 401/403 wie
//               bei den anderen drei Anbietern ueblich
//
// Andere Fehler (429 Rate-Limit, 5xx, Netzwerkausfall der Pruefung selbst)
// sind kein eindeutiges Signal fuer "Key ungueltig" - in diesen Faellen wird
// NICHT blockiert, um einen echten gueltigen Key nicht faelschlich
// abzulehnen (lieber ungeprueft speichern als einen Nutzer bei einem
// Infrastruktur-Hickup komplett auszusperren).
export async function validateLlmKey(
  provider: LlmProvider,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    switch (provider) {
      case "claude":
        res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        });
        break;
      case "openai":
        res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        break;
      case "gemini":
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        );
        break;
      case "openrouter":
        res = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        break;
    }
  } catch (e) {
    console.error(`[validateLlmKey] ${provider}: Pruefung nicht erreichbar, nicht blockiert -`, (e as Error).message);
    return { ok: true };
  }

  if (res.ok) return { ok: true };

  const invalidStatus = provider === "gemini" ? res.status === 400 : res.status === 401;
  if (invalidStatus) {
    return { ok: false, error: "Der eingegebene API-Key scheint ungültig zu sein." };
  }

  console.error(`[validateLlmKey] ${provider}: unerwarteter HTTP-Status ${res.status}, nicht blockiert`);
  return { ok: true };
}
