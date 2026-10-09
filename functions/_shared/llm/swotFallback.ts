// Fallback fuer swot als Text (beobachtet im US-Lauf 08./09.10.2026, EXR,
// FAST, TEL): Claude liefert das Tool-Feld swot nicht als Objekt, sondern
// als String mit JSON darin - teils mit angehaengtem Rest der Antwort
// (`{...},"fazit":"...","firmenbeschreibung_de":"..."}`), teils mit
// ueberzaehligem Komma (`{...},`). Ohne Fallback landete der String in
// chart_data.swot; App und PDF fanden weder SWOT noch Rueckenwind/Gegenwind,
// und das Fazit fehlte.
//
// Reiner Fallback: greift nur, wenn swot ein String ist. Ein gueltiges
// swot-Objekt bleibt unveraendert. Kein Einfluss auf Prompt oder Scores.

export interface Swot {
  staerken: string[];
  schwaechen: string[];
  chancen: string[];
  risiken: string[];
}

export interface SwotFallbackResult {
  // true = swot war Text und wurde in ein Objekt umgewandelt.
  recovered: boolean;
  // Objekt (gerettet oder unveraendert), null wenn nicht lesbar.
  swot: Swot | Record<string, unknown> | null;
  // Aus dem Rest des Textes gelesene Felder (nur Strings).
  extra: { fazit?: string; firmenbeschreibung_de?: string };
  // Grund, wenn ein Text nicht gerettet werden konnte.
  error?: string;
}

const SWOT_KEYS = ["staerken", "schwaechen", "chancen", "risiken"] as const;

// HTML-Kommentare (z.B. `<!-- -->` mitten im JSON, Fall FE) und
// ueberzaehlige Kommas vor } oder ] entfernen.
function clean(json: string): string {
  return json.replace(/<!--[\s\S]*?-->/g, "").replace(/,\s*([}\]])/g, "$1");
}

// Index der schliessenden Klammer zum ersten "{" (Strings und Escapes
// werden beachtet), -1 wenn keine passende gefunden.
function matchingBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function toSwot(obj: unknown): Swot | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (!SWOT_KEYS.some((k) => Array.isArray(o[k]))) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { staerken: list(o.staerken), schwaechen: list(o.schwaechen), chancen: list(o.chancen), risiken: list(o.risiken) };
}

// Liest ein swot-Objekt aus einem Text: erstes {...} als swot, ein
// eventueller Rest (`,"fazit":"...", ...}`) als weitere Felder.
export function parseSwotText(text: string): SwotFallbackResult {
  const s = clean(text).trim();
  const start = s.indexOf("{");
  if (start < 0) return { recovered: false, swot: null, extra: {}, error: "kein JSON-Objekt im Text" };
  const end = matchingBrace(s, start);
  if (end < 0) return { recovered: false, swot: null, extra: {}, error: "JSON-Objekt nicht geschlossen" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return { recovered: false, swot: null, extra: {}, error: `Parse-Fehler: ${(e as Error).message}` };
  }
  const swot = toSwot(parsed);
  if (!swot) return { recovered: false, swot: null, extra: {}, error: "keine SWOT-Listen im Objekt" };

  const extra: SwotFallbackResult["extra"] = {};
  let rest = s.slice(end + 1).trim().replace(/^,/, "").trim();
  if (rest.startsWith('"')) {
    if (!rest.endsWith("}")) rest += "}";
    try {
      const more = JSON.parse(clean("{" + rest)) as Record<string, unknown>;
      if (typeof more.fazit === "string" && more.fazit.trim()) extra.fazit = more.fazit.trim();
      if (typeof more.firmenbeschreibung_de === "string" && more.firmenbeschreibung_de.trim()) {
        extra.firmenbeschreibung_de = more.firmenbeschreibung_de.trim();
      }
    } catch {
      // Rest nicht lesbar - swot bleibt trotzdem gerettet.
    }
  }
  return { recovered: true, swot, extra };
}

// Einstieg fuer parseAnalysisResult(): nur Strings werden umgewandelt.
export function recoverSwot(value: unknown): SwotFallbackResult {
  if (typeof value !== "string") {
    return { recovered: false, swot: (value as Record<string, unknown> | null | undefined) ?? null, extra: {} };
  }
  return parseSwotText(value);
}
