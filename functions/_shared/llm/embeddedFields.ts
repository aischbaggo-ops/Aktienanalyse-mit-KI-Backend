// Fangnetz a): Das Modell schreibt Tool-Felder gelegentlich als Text in einen
// String-Wert (v.a. fazit) statt als eigene Properties. Diese reine Funktion
// (kein DB-/Netzzugriff, kein Import aus prompt.ts) erkennt solche Reste,
// schneidet den Anzeigetext ab, rettet gueltige Felder und liefert einen
// Befund fuer das llm_output_anomaly-Event. Sie ist so gebaut, dass ein
// spaeteres Reparaturskript sie auf gespeicherte Zeilen anwenden kann.
//
// Grundsaetze:
// - Eingebettete Werte ERGAENZEN nur. Ein gueltiges Tool-Feld wird nie
//   ueberschrieben; bei Abweichung gewinnt das vorhandene Feld (conflicts).
// - Gerettete kriterien werden strikt gegen das Schema geprueft. Faellt das
//   durch, wird NICHTS aus den Resten uebernommen.
// - Der abgeschnittene Rest dient nur als Quelle, nie zur Anzeige.

export interface RescueOptions {
  // Property-Namen des Tool-Schemas (ANALYSIS_TOOL_SCHEMA.properties).
  fieldNames: readonly string[];
  // Gueltige Kriteriennamen (Object.keys(QUAL_WEIGHTS)); deren Anzahl ist
  // zugleich die geforderte Anzahl Eintraege.
  criteriaNames: readonly string[];
}

export interface RescueResult {
  // true, sobald in einem String-Feld ein Marker steht.
  touched: boolean;
  markers: string[];
  // Nur uebernommene Werte (Feld fehlte oder war ungueltig, Rest war gueltig).
  adopted: Record<string, unknown>;
  // Bereinigte Anzeigetexte; nur gesetzt, wenn genug Text vor dem ersten
  // Marker stand (MIN_TEXT_CHARS).
  cleanText: { fazit?: string; firmenbeschreibung_de?: string };
  conflicts: { field: string; existing: string; embedded: string }[];
  rejected: { field: string; reason: string }[];
  // Kurzgruende fuer das Event, z.B. "embedded_recovered".
  reasons: string[];
}

// Mindestlaenge des Anzeigetexts nach dem Abschneiden. Der Prompt verlangt
// fuer das Fazit 2 bis 4 Saetze; die kuerzesten sauberen Fazits im Bestand
// haben rund 540 Zeichen. 200 liegt klar darunter (kein Fehlalarm bei kurzen
// echten Texten), aber weit ueber einem abgerissenen Satzanfang. Die
// Firmenbeschreibung (2 bis 4 Saetze) bekommt 100. Darunter wird NICHT
// gekuerzt, sondern nur ein Event geschrieben.
export const MIN_TEXT_CHARS: Record<string, number> = { fazit: 200, firmenbeschreibung_de: 100 };

const TEXT_FIELDS = ["fazit", "firmenbeschreibung_de"] as const;
const AMPEL_VALUES = ["gruen", "gelb", "rot", "grau"];
const MAX_EVENT_VALUE_CHARS = 2000;

interface Marker {
  name: string;
  re: RegExp;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Kanonische Marker: "<parameter", "</invoke>" und je Schema-Feld "<feld"
// (oeffnend, tolerant gegen <feld>, <feld">, Leerzeichen) und "</feld>".
export function embeddedMarkers(fieldNames: readonly string[]): Marker[] {
  const list: Marker[] = [
    { name: "<parameter", re: /<\s*parameter\b/i },
    { name: "</invoke>", re: /<\s*\/\s*invoke\s*>/i },
  ];
  for (const n of fieldNames) {
    const e = escapeRe(n);
    list.push({ name: `<${n}`, re: new RegExp(`<\\s*${e}\\b`, "i") });
    list.push({ name: `</${n}>`, re: new RegExp(`<\\s*\\/\\s*${e}\\s*>`, "i") });
  }
  return list;
}

export function listMarkers(text: string, markers: Marker[]): string[] {
  return markers.filter((m) => m.re.test(text)).map((m) => m.name);
}

function firstMarkerIndex(text: string, markers: Marker[]): number {
  let best = -1;
  for (const m of markers) {
    const i = text.search(m.re);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

interface Segment {
  name: string;
  value: string;
}

// Zerlegt den Rest in Segmente je Schema-Feld. Toleriert <tag>, <tag">,
// <parameter name="tag"> (auch mit einfachen Anfuehrungszeichen), Leerzeichen
// und fehlende schliessende Tags: ein Wert endet am passenden Schliess-Tag,
// am naechsten bekannten Oeffnungs-Tag, an </invoke> oder am Textende.
function parseSegments(rest: string, fieldNames: readonly string[]): Segment[] {
  const names = new Set(fieldNames.map((n) => n.toLowerCase()));
  const openRe = /<\s*(?:parameter\s+name\s*=\s*["']?([A-Za-z_]+)["']?\s*|([A-Za-z_]+)["']?\s*)>/g;
  const opens: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(rest)) !== null) {
    const name = (m[1] ?? m[2] ?? "").toLowerCase();
    if (names.has(name)) opens.push({ name, start: m.index, end: m.index + m[0].length });
  }
  const closeRe = /<\s*\/\s*(?:[A-Za-z_]+)\s*>/g;
  const segments: Segment[] = [];
  for (let i = 0; i < opens.length; i++) {
    const o = opens[i];
    let end = i + 1 < opens.length ? opens[i + 1].start : rest.length;
    closeRe.lastIndex = o.end;
    const c = closeRe.exec(rest);
    if (c && c.index < end) end = c.index;
    segments.push({ name: o.name, value: rest.slice(o.end, end) });
  }
  return segments;
}

function parseJsonLoose(value: string): unknown {
  const t = value.trim();
  try {
    return JSON.parse(t);
  } catch {
    const open = t.search(/[[{]/);
    if (open < 0) throw new Error("kein JSON");
    const closeCh = t[open] === "[" ? "]" : "}";
    const close = t.lastIndexOf(closeCh);
    if (close <= open) throw new Error("kein JSON");
    return JSON.parse(t.slice(open, close + 1));
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isSwot(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return ["staerken", "schwaechen", "chancen", "risiken"].every((k) => isStringArray(o[k]));
}

// Strikte Pruefung gerettetes kriterien: genau die geforderte Anzahl, jeder
// Name gueltig und eindeutig, ampel im Enum, begruendung nicht leer.
export function validateKriterien(value: unknown, criteriaNames: readonly string[]): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(value)) return { ok: false, reason: "kein Array" };
  if (value.length !== criteriaNames.length) {
    return { ok: false, reason: `${value.length} statt ${criteriaNames.length} Eintraege` };
  }
  const allowed = new Set(criteriaNames);
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const k = value[i] as Record<string, unknown> | null;
    if (!k || typeof k !== "object") return { ok: false, reason: `Eintrag ${i} kein Objekt` };
    if (typeof k.name !== "string" || !allowed.has(k.name)) return { ok: false, reason: `Eintrag ${i}: unbekannter Name` };
    if (seen.has(k.name)) return { ok: false, reason: `Eintrag ${i}: doppelter Name` };
    seen.add(k.name);
    if (typeof k.ampel !== "string" || !AMPEL_VALUES.includes(k.ampel)) return { ok: false, reason: `Eintrag ${i}: ungueltige ampel` };
    if (typeof k.begruendung !== "string" || k.begruendung.trim() === "") return { ok: false, reason: `Eintrag ${i}: begruendung leer` };
  }
  return { ok: true };
}

function parseFieldValue(name: string, raw: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    if (name === "kriterien") return { ok: true, value: parseJsonLoose(raw) };
    if (name === "warnings") {
      const v = parseJsonLoose(raw);
      return isStringArray(v) ? { ok: true, value: v } : { ok: false, reason: "warnings keine String-Liste" };
    }
    if (name === "swot") {
      const v = parseJsonLoose(raw);
      return isSwot(v) ? { ok: true, value: v } : { ok: false, reason: "swot ohne vier String-Listen" };
    }
    if (name === "no_go_hart") {
      const t = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (t === "true") return { ok: true, value: true };
      if (t === "false") return { ok: true, value: false };
      return { ok: false, reason: "no_go_hart weder true noch false" };
    }
    if (name === "firmenbeschreibung_de") {
      const t = raw.trim();
      return t === "" ? { ok: false, reason: "firmenbeschreibung_de leer" } : { ok: true, value: t };
    }
    return { ok: false, reason: "Feld wird nicht gerettet" };
  } catch (e) {
    return { ok: false, reason: `Parse-Fehler: ${(e as Error).message}` };
  }
}

function hasValidExisting(name: string, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (name === "kriterien") return Array.isArray(v);
  if (name === "warnings") return Array.isArray(v);
  if (name === "swot") return !!v && typeof v === "object" && !Array.isArray(v);
  if (name === "no_go_hart") return typeof v === "boolean";
  if (name === "firmenbeschreibung_de") return typeof v === "string" && v.trim() !== "";
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function forEvent(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  return s.length > MAX_EVENT_VALUE_CHARS ? s.slice(0, MAX_EVENT_VALUE_CHARS) + "…" : s;
}

const RESCUE_FIELDS = ["kriterien", "warnings", "no_go_hart", "swot", "firmenbeschreibung_de"] as const;

export function rescueEmbeddedFields(toolInput: Record<string, unknown> | null | undefined, opts: RescueOptions): RescueResult {
  const result: RescueResult = {
    touched: false,
    markers: [],
    adopted: {},
    cleanText: {},
    conflicts: [],
    rejected: [],
    reasons: [],
  };
  if (!toolInput) return result;

  const markers = embeddedMarkers(opts.fieldNames);
  const sources: { field: string; text: string; idx: number }[] = [];
  const found = new Set<string>();
  for (const field of TEXT_FIELDS) {
    const text = toolInput[field];
    if (typeof text !== "string") continue;
    const idx = firstMarkerIndex(text, markers);
    if (idx < 0) continue;
    sources.push({ field, text, idx });
    listMarkers(text, markers).forEach((m) => found.add(m));
  }
  if (sources.length === 0) return result;

  result.touched = true;
  result.markers = markers.map((m) => m.name).filter((n) => found.has(n));

  // 1) Anzeigetext ab dem ersten Marker abschneiden.
  for (const s of sources) {
    const clean = s.text.slice(0, s.idx).trim();
    if (clean.length >= (MIN_TEXT_CHARS[s.field] ?? 0)) {
      result.cleanText[s.field as "fazit" | "firmenbeschreibung_de"] = clean;
    } else {
      result.reasons.push(`${s.field}_too_short_after_cut`);
    }
  }

  // 2) Segmente aus dem Rest (nur als Quelle) lesen; je Feld zaehlt das erste.
  const candidates: Record<string, unknown> = {};
  for (const s of sources) {
    for (const seg of parseSegments(s.text.slice(s.idx), opts.fieldNames)) {
      if (!(RESCUE_FIELDS as readonly string[]).includes(seg.name)) continue;
      if (seg.name in candidates) continue;
      const parsed = parseFieldValue(seg.name, seg.value);
      if (parsed.ok) candidates[seg.name] = parsed.value;
      else result.rejected.push({ field: seg.name, reason: parsed.reason });
    }
  }

  // 3) Gerettete kriterien strikt pruefen; bei Fehlschlag nichts uebernehmen.
  let discardAll = false;
  if ("kriterien" in candidates) {
    const v = validateKriterien(candidates.kriterien, opts.criteriaNames);
    if (!v.ok) {
      result.rejected.push({ field: "kriterien", reason: v.reason });
      result.reasons.push("kriterien_invalid");
      discardAll = true;
    }
  } else if (result.rejected.some((r) => r.field === "kriterien")) {
    result.reasons.push("kriterien_invalid");
    discardAll = true;
  }

  if (discardAll) {
    result.reasons.push("embedded_discarded");
    return result;
  }

  // 4) Zusammenfuehren: nur ergaenzen, nie ueberschreiben.
  for (const field of RESCUE_FIELDS) {
    if (!(field in candidates)) continue;
    const embedded = candidates[field];
    const existing = toolInput[field];
    if (hasValidExisting(field, existing)) {
      if (!deepEqual(existing, embedded)) {
        result.conflicts.push({ field, existing: forEvent(existing), embedded: forEvent(embedded) });
      }
      continue;
    }
    result.adopted[field] = embedded;
  }
  if (result.conflicts.length > 0) result.reasons.push("embedded_conflict");
  if (Object.keys(result.adopted).length > 0) result.reasons.push("embedded_recovered");
  if (result.adopted.no_go_hart === true && toolInput.no_go_hart === undefined) {
    result.reasons.push("no_go_hart_true_from_embedded");
  }
  if (Object.keys(result.adopted).length === 0 && result.conflicts.length === 0) {
    result.reasons.push("nothing_adopted");
  }
  return result;
}
