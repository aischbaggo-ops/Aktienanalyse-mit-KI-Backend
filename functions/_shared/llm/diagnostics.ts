// Reine Diagnose-Logik fuer auffaellige LLM-Ausgaben (T-M7-Nachfolge): kein
// DB-Zugriff, keine Seiteneffekte, beeinflusst weder Parser noch Score noch
// Status. analyse/index.ts schreibt das Ergebnis als app_events-Eintrag
// (event_type "llm_output_anomaly", status "suspicious").
import { ANALYSIS_TOOL_SCHEMA } from "./prompt.ts";

// Muster, die zeigen, dass das Modell Tool-Felder als Text in einen String
// (v.a. fazit) geschrieben hat statt als eigene Properties.
export const EMBEDDED_MARKERS = [
  "<parameter",
  "</invoke>",
  "</fazit>",
  "<kriterien>",
  "<swot>",
  "<warnings>",
] as const;

// "20 KB" fuer das rohe toolInput im Event (UTF-8-Bytes).
export const MAX_TOOL_INPUT_BYTES = 20 * 1024;

const MAX_WALK_DEPTH = 12;

export interface EmbeddedMarkerHits {
  markers: string[];
  fields: string[];
}

export function findEmbeddedMarkers(value: unknown): EmbeddedMarkerHits {
  const markers = new Set<string>();
  const fields: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > MAX_WALK_DEPTH) return;
    if (typeof v === "string") {
      const hit = EMBEDDED_MARKERS.filter((m) => v.includes(m));
      if (hit.length > 0) {
        hit.forEach((m) => markers.add(m));
        fields.push(path || "(root)");
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        walk(item, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(value, "", 0);
  return { markers: EMBEDDED_MARKERS.filter((m) => markers.has(m)), fields };
}

// Pflichtfelder des Tool-Schemas, die als eigene Property fehlen (kriterien
// zaehlt nur als vorhanden, wenn es ein Array ist).
export function missingToolFields(toolInput: Record<string, unknown> | null): string[] {
  const required: readonly string[] = ANALYSIS_TOOL_SCHEMA.required;
  if (!toolInput) return [...required];
  return required.filter((f) => {
    const v = toolInput[f];
    if (f === "kriterien") return !Array.isArray(v);
    return v === undefined || v === null;
  });
}

export function missingScoreParts(parts: {
  fundamental: number | null;
  qualitaet: number | null;
  krise: number | null;
  trend: number | null;
}): string[] {
  return [
    parts.fundamental === null ? "Fundamental" : null,
    parts.qualitaet === null ? "Qualitaet" : null,
    parts.krise === null ? "Krise" : null,
    parts.trend === null ? "Trend" : null,
  ].filter((x): x is string => x !== null);
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false, bytes: bytes.length };
  const cut = new TextDecoder("utf-8").decode(bytes.slice(0, maxBytes)).replace(/�+$/, "");
  return { text: cut, truncated: true, bytes: bytes.length };
}

export interface LlmAnomalyInput {
  ticker: string;
  provider: string;
  callType: string;
  model: string | null;
  stopReason: string | null;
  toolInput: Record<string, unknown> | null;
  scoreQualitaet: number | null;
  missingScoreParts: string[];
  parseError?: string | null;
}

export interface LlmAnomaly {
  reasons: string[];
  details: Record<string, unknown>;
}

// null, wenn nichts auffaellig ist. Ausloeser: scoreQualitaet ist null ODER
// ein Marker steckt in einem String-Feld des Tool-Outputs (auch wenn
// kriterien korrekt vorhanden ist - der MSFT/DIS-Fall).
export function detectLlmAnomaly(input: LlmAnomalyInput): LlmAnomaly | null {
  const hits = findEmbeddedMarkers(input.toolInput);
  const reasons: string[] = [];
  if (input.scoreQualitaet === null) reasons.push("score_qualitaet_null");
  if (hits.markers.length > 0) reasons.push("embedded_markers");
  if (reasons.length === 0) return null;

  const details: Record<string, unknown> = {
    ticker: input.ticker,
    provider: input.provider,
    call_type: input.callType,
    model: input.model,
    stop_reason: input.stopReason,
    reasons,
    missing_score_parts: input.missingScoreParts,
    missing_tool_fields: missingToolFields(input.toolInput),
    markers: hits.markers,
    marker_fields: hits.fields,
    parse_error: input.parseError ?? null,
  };

  if (input.toolInput === null) {
    details.tool_input = null;
  } else {
    const json = JSON.stringify(input.toolInput);
    const t = truncateUtf8(json, MAX_TOOL_INPUT_BYTES);
    details.tool_input_bytes = t.bytes;
    if (t.truncated) {
      details.tool_input_truncated = true;
      details.tool_input_json = t.text;
    } else {
      details.tool_input = input.toolInput;
    }
  }

  return { reasons, details };
}
