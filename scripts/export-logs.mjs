#!/usr/bin/env node
// ENTWURF, nicht ausgefuehrt. Taeglicher Export NEUER Zeilen der Log-Tabellen als CSV.
//
//   node scripts/export-logs.mjs --out "<Ordner ausserhalb von git>" [--dry-run]
//
// - Nur SELECT ueber die eingeloggte Supabase-CLI (`supabase db query --linked`),
//   kein Key im Skript, nichts wird geloescht oder geschrieben ausser den CSV-Dateien
//   und der Status-Datei im --out-Ordner.
// - Spalten sind eine feste Whitelist. Nicht exportiert werden: Roh-LLM-Ausgabe
//   (app_events.details.tool_input, tool_input_json), E-Mail-Adressen (details.email),
//   volle user_id (nur die ersten 8 Zeichen als user_ref). Freitext wird von
//   Schluesselmustern bereinigt und auf 2000 Zeichen gekuerzt.
// - Zeitraum je Tabelle: created_at > letzter Stand minus Ueberlappung. Bereits
//   exportierte ids (Status-Datei) werden uebersprungen.
// - Taeglich laufen lassen. api_call_log und app_events werden per pg_cron nach 7 Tagen
//   geloescht (migrations/20260925090000), der Export muss davor laufen.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TEXT = 2000;
const OVERLAP_MINUTES = 15;
const FIRST_RUN_DAYS = 7;

export const TABLES = [
  {
    name: "api_call_log",
    ts: "created_at",
    select:
      "id, created_at, function_name, provider, call_type, ticker, success, duration_ms, tokens_input, tokens_output, cost_usd, stop_reason, model, error_message",
  },
  {
    name: "request_log",
    ts: "requested_at",
    select:
      "id, requested_at, ticker, left(user_id::text, 8) as user_ref, source, max_age_days, force_refresh, status, duration_ms, data_quality, score_total, score_fundamental, score_qualitaet, score_krise, score_trend, score_stabilitaet, deviation_triggered, deviation_amount, error_message",
  },
  {
    name: "function_errors",
    ts: "created_at",
    select: "id, created_at, function_name, left(user_id::text, 8) as user_ref, llm_provider, error_message",
  },
  {
    name: "app_events",
    ts: "created_at",
    select:
      "id, created_at, event_type, function_name, status, left(user_id::text, 8) as user_ref, (coalesce(details, '{}'::jsonb) - 'tool_input' - 'tool_input_json' - 'email')::text as details",
  },
];

const SECRET_PATTERNS = [
  /sk-ant-[\w-]+/g,
  /sk-or-[\w-]+/g,
  /\bsk-[\w-]{20,}/g,
  /AIza[\w-]{30,}/g,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /Bearer\s+[\w.~+/=-]+/gi,
  /((?:api[_-]?key|apikey|token|authorization|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

export function redact(text) {
  if (text == null) return "";
  let s = String(text);
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m, p1) => (p1 ? `${p1}[REDACTED]` : "[REDACTED]"));
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}...[gekuerzt]` : s;
}

export function csvCell(value) {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const TEXT_COLUMNS = new Set(["error_message", "details"]);

export function toCsvLine(columns, row) {
  return columns.map((c) => csvCell(TEXT_COLUMNS.has(c) ? redact(row[c]) : row[c])).join(",");
}

function assertOutsideGit(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (out === "true") throw new Error(`--out liegt in einem Git-Repository: ${dir}`);
  } catch (e) {
    if (String(e.message).startsWith("--out")) throw e;
  }
}

function runQuery(sql) {
  const file = join(tmpdir(), `export-logs-${process.pid}.sql`);
  writeFileSync(file, sql);
  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  const raw = execFileSync(bin, ["supabase", "db", "query", "--linked", "--file", file], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  return JSON.parse(raw.slice(raw.indexOf("{"))).rows;
}

function sinceFor(state, table) {
  const last = state[table.name]?.lastTs;
  const base = last ? new Date(last) : new Date(Date.now() - FIRST_RUN_DAYS * 24 * 3600 * 1000);
  return new Date(+base - OVERLAP_MINUTES * 60 * 1000).toISOString();
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const dryRun = args.includes("--dry-run");
  if (outIdx < 0 || !args[outIdx + 1]) {
    console.error('Aufruf: node scripts/export-logs.mjs --out "<Ordner>" [--dry-run]');
    process.exit(2);
  }
  const out = resolve(args[outIdx + 1]);
  mkdirSync(out, { recursive: true });
  assertOutsideGit(out);

  const statePath = join(out, ".export_state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const day = new Date().toISOString().slice(0, 10);

  for (const table of TABLES) {
    const since = sinceFor(state, table);
    const sql = `select ${table.select} from ${table.name} where ${table.ts} > '${since}' and ${table.ts} <= now() order by ${table.ts}, id;`;
    if (dryRun) {
      console.log(`[dry-run] ${table.name}: ${sql}`);
      continue;
    }
    const seen = new Set(state[table.name]?.seenIds ?? []);
    const rows = runQuery(sql).filter((r) => !seen.has(r.id));
    if (rows.length === 0) {
      console.log(`${table.name}: 0 neue Zeilen`);
      continue;
    }
    const columns = Object.keys(rows[0]);
    const dir = join(out, table.name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${table.name}_${day}.csv`);
    const lines = rows.map((r) => toCsvLine(columns, r));
    appendFileSync(file, `${existsSync(file) && readFileSync(file, "utf8").length > 0 ? "" : `${columns.join(",")}\n`}${lines.join("\n")}\n`);

    const lastTs = rows.reduce((m, r) => (r[table.ts] > m ? r[table.ts] : m), rows[0][table.ts]);
    const keptIds = [...seen, ...rows.map((r) => r.id)].slice(-5000);
    state[table.name] = { lastTs: new Date(lastTs).toISOString(), seenIds: keptIds };
    console.log(`${table.name}: ${rows.length} neue Zeilen -> ${file}`);
  }
  if (!dryRun) writeFileSync(statePath, JSON.stringify(state, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
