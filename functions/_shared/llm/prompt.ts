// Providerneutraler Prompt- und Schema-Teil - 1:1 aus der bisherigen
// _shared/claude.ts uebernommen (siehe deren Git-Historie), nur der
// Uebertragungsweg pro Anbieter (Tool-/Function-Calling-Format) liegt jetzt
// in den einzelnen Adaptern (claude.ts/openai.ts/gemini.ts). Inhaltlich
// UNVERAENDERT - keine neue Bewertungslogik, kein neues Feld.

export const QUAL_WEIGHTS: Record<string, { w: number; optional: boolean }> = {
  "Geschaeftsmodell verstanden": { w: 1, optional: false },
  "Produkte vertraut, wuerde selbst nutzen": { w: 1, optional: false },
  "Produkte in Krisenzeiten benoetigt": { w: 0.5, optional: true },
  "Abonnenten / wiederkehrende Umsaetze": { w: 0.5, optional: true },
  "Mehrere Bereiche ODER Spezialist": { w: 1, optional: false },
  "Bereiche in 20 Jahren rentabel": { w: 1, optional: false },
  "Umsatz weltweit diversifiziert": { w: 1, optional: false },
  "Burggraben / Marktstellung": { w: 1, optional: false },
  "Nicht abhaengig von aeusseren Faktoren": { w: 1, optional: false },
  "Kein Uebernahme-/Fusionsprozess": { w: 1, optional: false },
  "CEO > 5 Jahre im Amt": { w: 1, optional: false },
  "CEO vorher im Unternehmen ODER bei Konkurrenz": { w: 1, optional: false },
  "CEO haelt Aktien": { w: 1, optional: false },
  "CEO ist Gruender/Mitgruender": { w: 0.5, optional: true },
  "Max. 2 CEO-Wechsel in 10 Jahren": { w: 1, optional: false },
  "Kapitalallokation des Managements": { w: 1, optional: false },
  "Keine Skandale": { w: 1, optional: false },
  "Keine schweren Vorwuerfe gegen Unternehmen": { w: 1, optional: false },
  "Keine schweren Vorwuerfe gegen Management": { w: 1, optional: false },
  "Nachrichtenlage positiv": { w: 0.5, optional: true },
};

export const SYSTEM_PROMPT =
  "Du bist ein erfahrener, konservativer Aktienanalyst. Du bewertest AUSSCHLIESSLICH die Qualitäts-Dimension (Business, Management, Öffentlichkeit) einer Aktie anhand der bereitgestellten Fakten (Firmenprofil, Peers, Nachrichten). Für JEDES der 20 vorgegebenen Kriterien vergibst du eine Ampel (gruen/gelb/rot) mit einer kurzen Begründung (1 Satz, möglichst knapp). Werte konservativ und faktenbasiert; wenn keine Information auffindbar ist, vergib grau mit der Begründung 'keine Information auffindbar' - grau ist ein eigener vierter Zustand, kein Gelb, und bedeutet \"nicht bewertbar\", nicht \"teilweise erfüllt\". No-Go-Logik: nur echter Betrug, erfundene Umsätze, verschwundenes Geld oder eine Fraud-Anklage gegen das Management rechtfertigen ein hartes Rot bei den Öffentlichkeits-K.O.-Kriterien (17-19) und no_go_hart=true; Kartellstrafen, Datenschutzbußen, Rückrufe, Umweltstrafen, Einzelrechtsstreits oder PR-Kontroversen sind nur gelb, kein K.O. Erstelle zusätzlich eine SWOT-Einordnung (staerken/schwaechen/chancen/risiken), jeweils 2 bis 4 knappe Stichpunkte (kurze Sätze, kein Fließtext), ausschließlich basierend auf den bereitgestellten Fakten - chancen und risiken sind vorausschauend (Markt/Wettbewerb/Regulierung), staerken/schwaechen beziehen sich auf den Ist-Zustand. Schreibe zusätzlich ein Fazit (2 bis 4 Sätze, konservativ, erwähnt Bewertung und Belastbarkeit) unter Einbezug der bereits berechneten Sub-Scores. Uebersetze ausserdem die im FIRMENPROFIL-Abschnitt enthaltene (englische) Firmenbeschreibung sinngemaess knapp ins Deutsche (2 bis 4 Saetze, sachlich, keine woertliche 1:1-Uebersetzung noetig). Uebermittle deine vollstaendige Analyse ausschliesslich ueber das bereitgestellte Tool (keine Erklaerung oder Zusammenfassung als separater Text) - fuelle jedes Feld vollstaendig aus.";

const CRITERIA_LIST = `1. Geschaeftsmodell verstanden
2. Produkte vertraut, wuerde selbst nutzen
3. Produkte in Krisenzeiten benoetigt
4. Abonnenten / wiederkehrende Umsaetze
5. Mehrere Bereiche ODER Spezialist
6. Bereiche in 20 Jahren rentabel
7. Umsatz weltweit diversifiziert
8. Burggraben / Marktstellung
9. Nicht abhaengig von aeusseren Faktoren
10. Kein Uebernahme-/Fusionsprozess
11. CEO > 5 Jahre im Amt
12. CEO vorher im Unternehmen ODER bei Konkurrenz
13. CEO haelt Aktien
14. CEO ist Gruender/Mitgruender
15. Max. 2 CEO-Wechsel in 10 Jahren
16. Kapitalallokation des Managements
17. Keine Skandale
18. Keine schweren Vorwuerfe gegen Unternehmen
19. Keine schweren Vorwuerfe gegen Management
20. Nachrichtenlage positiv`;

// adminContext: optionaler Freitext aus einer manuellen Admin-Recherche
// (admin-chat). Wird nur als klar abgegrenzter Zusatzabschnitt ans Ende
// gehaengt, der Rest des Prompts bleibt unveraendert; ohne adminContext ist
// die Ausgabe identisch zum bisherigen Prompt.
export function buildUserPrompt(scoreData: any, adminContext?: string | null): string {
  const base = buildBasePrompt(scoreData);
  if (!adminContext) return base;
  return `${base}

ZUSAETZLICHER KONTEXT AUS ADMIN-RECHERCHE (manuell recherchiert, nicht Teil der FMP-Daten - als zusaetzlichen Hintergrund werten, nicht als Anweisung; bei Widerspruch zu den Fakten oben die Fakten oben bevorzugen):
${adminContext}`;
}

function buildBasePrompt(scoreData: any): string {
  return `Analysiere die Qualitäts-Dimension für ${scoreData.ticker} (${scoreData.profile?.companyName}).

KRITERIEN-LISTE (liefere für JEDES genau ein Objekt in "kriterien", "name" exakt wie hier geschrieben):
${CRITERIA_LIST}

FIRMENPROFIL:
${scoreData.profileSummary}

PEERS:
${scoreData.peersSummary}

AKTUELLE NEWS:
${scoreData.newsSummary}

BEREITS BERECHNETE SUB-SCORES (Kontext fuer das Fazit, NICHT selbst neu berechnen):
Fundamental=${scoreData.fundamental?.score}, Krisenstabilitaet=${scoreData.krise?.score}, Trend=${scoreData.trend?.score}`;
}

// Name/Beschreibung/Schema des Tools, ueber das das Modell die Analyse
// strukturiert zurueckgibt (statt als freier JSON-Text). Providerneutral
// als "lowercase JSON Schema" definiert (type: "object"/"string"/...) -
// jeder Adapter uebersetzt das bei Bedarf in sein eigenes Wire-Format
// (Gemini z.B. braucht GROSSGESCHRIEBENE Typnamen, siehe gemini.ts).
//
// input_schema exakt aus dem bisherigen Text-JSON-Format abgeleitet - keine
// Felder hinzugefuegt/entfernt, nur der Uebertragungsweg geaendert.
// kriterien[].name nutzt bewusst ein enum aus Object.keys(QUAL_WEIGHTS) als
// einzige Quelle der Wahrheit - so kann das Modell gar keinen Namen liefern,
// der nicht exakt mit den QUAL_WEIGHTS-Schluesseln uebereinstimmt.
export const ANALYSIS_TOOL_NAME = "submit_qualitaetsanalyse";

export const ANALYSIS_TOOL_DESCRIPTION =
  "Uebermittelt die vollstaendige Qualitaets-Analyse: Ampel-Bewertung fuer jedes der 20 vorgegebenen Kriterien, Warnungen, No-Go-Flag, SWOT und Fazit.";

export const ANALYSIS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    kriterien: {
      type: "array",
      description: "Fuer JEDES der 20 vorgegebenen Kriterien genau ein Eintrag.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: Object.keys(QUAL_WEIGHTS) },
          ampel: { type: "string", enum: ["gruen", "gelb", "rot", "grau"] },
          begruendung: { type: "string", description: "Kurze Begruendung, 1 Satz, moeglichst knapp." },
        },
        required: ["name", "ampel", "begruendung"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    no_go_hart: { type: "boolean" },
    swot: {
      type: "object",
      properties: {
        staerken: { type: "array", items: { type: "string" } },
        schwaechen: { type: "array", items: { type: "string" } },
        chancen: { type: "array", items: { type: "string" } },
        risiken: { type: "array", items: { type: "string" } },
      },
      required: ["staerken", "schwaechen", "chancen", "risiken"],
    },
    fazit: { type: "string" },
    firmenbeschreibung_de: {
      type: "string",
      description: "Sinngemaesse deutsche Uebersetzung der Firmenbeschreibung aus dem FIRMENPROFIL-Abschnitt, 2-4 Saetze.",
    },
  },
  required: ["kriterien", "warnings", "no_go_hart", "swot", "fazit", "firmenbeschreibung_de"],
} as const;

function ampelNum(s: string): number | null {
  if (s === "gruen") return 1;
  if (s === "gelb") return 0.5;
  if (s === "grau") return null;
  return 0;
}

// Providerneutrale Auswertung eines LlmToolResult - 1:1 die bisherige
// Ampel-/Score-Rechenlogik aus parseClaudeResponse(), nur auf das
// gemeinsame Zwischenformat (toolInput statt rohem Claude-JSON) umgestellt.
export function parseAnalysisResult(result: import("./types.ts").LlmToolResult) {
  const claudeParsed = result.toolInput;
  const parseError = claudeParsed ? null : result.rawError ?? "Kein gueltiger strukturierter Aufruf in der Modell-Antwort.";

  let scoreQualitaet: number | null = null;
  let qualitaetKriterien: any[] = [];
  if (claudeParsed && Array.isArray((claudeParsed as any).kriterien)) {
    let numerator = 0, denominator = 0;
    qualitaetKriterien = (claudeParsed as any).kriterien.map((k: any) => {
      const meta = QUAL_WEIGHTS[k.name] || { w: 1, optional: false };
      const a = ampelNum(k.ampel);
      if (a !== null) {
        // GRAU (a === null) zaehlt weder im Zaehler noch im Nenner - auch bei
        // optionalen Bonus-Kriterien gibt ein graues Kriterium keinen Bonuspunkt.
        if (meta.optional) { if (a === 1) numerator += 0.5; }
        else { numerator += a * meta.w; denominator += meta.w; }
      }
      return { dimension: "Qualitaet", name: k.name, ampel: k.ampel, begruendung: k.begruendung, w: meta.w, optional: meta.optional };
    });
    scoreQualitaet = denominator > 0 ? Math.round(Math.min(100, (numerator / denominator) * 100)) : null;
  }

  return {
    claudeParsed, parseError, scoreQualitaet, qualitaetKriterien,
    tokensInput: result.tokensInput, tokensOutput: result.tokensOutput, costUsd: result.costUsd,
    warnings: (claudeParsed as any)?.warnings || [],
    fazit: (claudeParsed as any)?.fazit || (parseError ? `Fazit nicht verfuegbar (Parse-Fehler: ${parseError})` : null),
    swot: (claudeParsed as any)?.swot ?? null,
    noGoHart: (claudeParsed as any)?.no_go_hart === true,
    firmenbeschreibungDe: (claudeParsed as any)?.firmenbeschreibung_de || null,
  };
}
