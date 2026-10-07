import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsFor } from "../_shared/cors.ts";
import { computeScores, computeStabilityScore, computePrognose, computeValuation, computeAnalystConsensus, computeBankRatings, ampelLabel, arr, first } from "../_shared/scoring.ts";
import { buildUserPrompt, callLLM, parseAnalysisResult, SYSTEM_PROMPT, type LlmProvider } from "../_shared/llm/index.ts";
import { verifyUser } from "../_shared/auth.ts";
import { loadUserApiKeys, loadActiveLlmKey } from "../_shared/userKeys.ts";
import { requireAdmin } from "../_shared/adminGate.ts";
import { logApiCall } from "../_shared/apiCallLog.ts";
import { logAppEvent } from "../_shared/appEvents.ts";
import { detectLlmAnomaly, missingScoreParts as listMissingScoreParts } from "../_shared/llm/diagnostics.ts";
import { mergePriceResults, priceHistoryPaths } from "../_shared/priceHistory.ts";
import { BENCHMARK_SYMBOL, buildDataFlags, fmpAuthErrorExcludingNews, llmRecoveredFrom } from "../_shared/dataFlags.ts";
import { fetchNews } from "../_shared/news.ts";
import { logFunctionError } from "../_shared/logFunctionError.ts";
import { checkUserRateLimit } from "../_shared/rateLimit.ts";
import { completionPatch, failurePatch, hasValidAnalysis, isCacheFresh, isRunActive, runNotActiveFilter, startPatch } from "../_shared/analysisRun.ts";
import { AnalysisAbort, preLlmAbort, profileAbort, rateLimitAbort, type RunErrorCode } from "../_shared/fmpStatus.ts";
import { resolveFmpSymbol } from "../_shared/tickerCheck.ts";

// Rate-Limit fuer neue Analyse-Laeufe (Audit M10 / urspruenglich Pentest-
// Scratchpad M1). BEWUSST hoeher als der dort genannte Beispielwert
// (20/Stunde): das Batch-Auswahl-Feature erlaubt bis zu 100 Ticker in
// einem einzigen Lauf - 20/Stunde wuerde jeden Batch-Lauf ueber 20 nicht
// gecachte Ticker mitten im Lauf mit 429 abbrechen. 120 laesst einen
// vollen 100er-Batch plus etwas Spielraum fuer normale Einzelanalysen in
// derselben Stunde zu.
const MAX_ANALYSES_PER_HOUR = 120;

// Anzeigename je Anbieter fuer Fehlermeldungen - gleiche Bezeichnungen wie
// im Frontend (KontoPage: "Claude (Standard) / ChatGPT / Gemini /
// OpenRouter").
const PROVIDER_LABELS: Record<LlmProvider, string> = {
  claude: "Claude",
  openai: "ChatGPT",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

// Obergrenze fuer den Admin-Recherche-Kontext im Analyse-Prompt (Zeichen).
const MAX_ADMIN_CONTEXT_CHARS = 8000;

// Wandelt eine rohe Fehlermeldung (oft ein voller Anbieter-JSON-Block mit
// internen Details/Metadaten, siehe z.B. die OpenRouter-Guardrail- oder
// "not a valid model ID"-Fehler aus echtem Nutzerfeedback) in eine kurze,
// verstaendliche deutsche Meldung fuer die Analyse-Detailseite um. Von uns
// selbst geschriebene, bereits klare Meldungen (FMP-Key/Ticker-Faelle oben
// in runAnalysis) werden unveraendert durchgereicht. Kein Treffer -> null,
// Frontend zeigt dann den bisherigen generischen Fallback-Text.
function classifyErrorForUser(rawMessage: string, provider: LlmProvider): string | null {
  if (rawMessage === "FMP-API-Key ungültig oder abgelaufen.") {
    return rawMessage;
  }

  const msg = rawMessage.toLowerCase();
  const label = PROVIDER_LABELS[provider];

  if (msg.includes("guardrail")) {
    return `Das gewählte Modell (${label}) wurde durch eine Guardrail-Einstellung deines ${label}-Kontos blockiert. Bitte prüfe die Einstellungen bei deinem Anbieter oder wähle ein anderes Modell.`;
  }
  if (
    msg.includes("not a valid model id") ||
    msg.includes("no endpoints found") ||
    msg.includes("model_not_found") ||
    (msg.includes("model") && msg.includes("does not exist"))
  ) {
    return `Der hinterlegte Modellname ist bei ${label} nicht gültig. Bitte prüfe den Modellnamen in den Kontoeinstellungen.`;
  }
  if (
    msg.includes("401") ||
    msg.includes("authentication_error") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("invalid api key") ||
    msg.includes("api key not valid") ||
    msg.includes("incorrect api key")
  ) {
    return `Der hinterlegte ${label}-API-Key ist ungültig oder abgelaufen. Bitte aktualisiere ihn in den Kontoeinstellungen.`;
  }
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("rate_limit")) {
    return `${label} hat die Anfrage wegen eines Rate-Limits abgelehnt. Bitte versuche es in ein paar Minuten erneut.`;
  }
  if (msg.includes("json") && (msg.includes("unterminated") || msg.includes("unexpected") || msg.includes("expected"))) {
    return `Die Antwort von ${label} konnte nicht verarbeitet werden (fehlerhaftes Format). Bitte versuche es erneut.`;
  }

  return null;
}

const FMP_BASE = "https://financialmodelingprep.com/stable";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// supabase-js wirft bei DB-Fehlern nicht, sondern liefert {error} zurueck.
// Frueher wurde das bei den Schreibzugriffen teils ignoriert - jetzt wird
// jeder Fehler mit Kontext geloggt. Rueckgabe true = geschrieben.
async function checkedWrite(
  context: string,
  ticker: string,
  op: PromiseLike<{ error: { message: string } | null }>,
): Promise<boolean> {
  const { error } = await op;
  if (error) console.error(`[analyse] DB-Schreibfehler (${context}) ticker=${ticker}: ${error.message}`);
  return !error;
}

function updateAnalysisRow(context: string, ticker: string, patch: Record<string, unknown>) {
  return checkedWrite(context, ticker, supabase.from("stock_analyses").update(patch).eq("ticker", ticker));
}

// Interner Fehlertext des letzten Laufs, nur fuer Admins lesbar (siehe
// Migration 20261007100000). null nach einem erfolgreichen Lauf.
function writeLastRunError(ticker: string, error: string | null) {
  return checkedWrite(
    "stock_analyses_last_run_error",
    ticker,
    supabase.from("stock_analyses_last_run_error").upsert({
      ticker,
      last_run_error: error,
      updated_at: new Date().toISOString(),
    }),
  );
}

async function fmpGet(path: string, fmpKey: string, ticker: string) {
  const startedAt = Date.now();
  let status: number | null = null;
  let bodyCopy: Response | null = null;
  try {
    const url = FMP_BASE + path + (path.includes("?") ? "&" : "?") + "apikey=" + fmpKey;
    const res = await fetch(url);
    status = res.status;
    // Nur beim News-Endpunkt eine Kopie des Bodys behalten: bei Nicht-JSON-
    // Antworten (Klartext wie "Restricted") bleibt so der Anfang fuer den
    // news_status erhalten. Verhalten und Logging sonst unveraendert.
    if (path.startsWith("/news/")) bodyCopy = res.clone();
    const data = await res.json();
    bodyCopy?.body?.cancel().catch(() => {});
    // FMP liefert bei ungueltigem/abgelaufenem Key HTTP 401/403 zurueck, aber
    // trotzdem einen normalen JSON-Body - ohne diese Unterscheidung sieht das
    // im weiteren Verlauf wie eine ganz normale Datenluecke aus (z.B.
    // Free-Plan-Limitierung) statt wie ein klar meldbarer Key-Fehler.
    const authError = res.status === 401 || res.status === 403;
    await logApiCall({
      functionName: "analyse",
      provider: "fmp",
      callType: path.split("?")[0],
      ticker,
      success: res.ok,
      durationMs: Date.now() - startedAt,
      errorMessage: res.ok ? null : `HTTP ${res.status}`,
    });
    return { ok: res.ok, data, authError, status };
  } catch (e) {
    let bodySnippet: string | null = null;
    if (bodyCopy) {
      try {
        bodySnippet = (await bodyCopy.text()).slice(0, 120);
      } catch {
        // Body nicht lesbar - dann bleibt es bei status/error.
      }
    }
    await logApiCall({
      functionName: "analyse",
      provider: "fmp",
      callType: path.split("?")[0],
      ticker,
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: (e as Error).message,
    });
    return { ok: false, error: (e as Error).message, authError: false, status, bodySnippet };
  }
}

async function fetchFmpData(ticker: string, fmpKey: string) {
  // Aktiengattungen (BRK.B / BRK-B): FMP kennt je nach Endpunkt nur eine
  // Schreibweise. Nur bei solchen Tickern ein Vorab-Profilaufruf; gespeichert
  // und angezeigt wird weiter die Eingabe, nur die FMP-Aufrufe nutzen sym.
  const sym = await resolveFmpSymbol(ticker, (s) => fmpGet(`/profile?symbol=${encodeURIComponent(s)}`, fmpKey, ticker));
  const [stockOld, stockNew] = priceHistoryPaths(sym);
  const [indexOld, indexNew] = priceHistoryPaths(BENCHMARK_SYMBOL);
  const [profile, peers, income, balance, cashflow, estimates, dcf, news, priceStockOld, priceStockNew, priceIndexOld, priceIndexNew, scores, priceTargetSummary, grades] = await Promise.all([
    fmpGet(`/profile?symbol=${sym}`, fmpKey, ticker),
    fmpGet(`/stock-peers?symbol=${sym}`, fmpKey, ticker),
    fmpGet(`/income-statement?symbol=${sym}&period=annual&limit=5`, fmpKey, ticker),
    fmpGet(`/balance-sheet-statement?symbol=${sym}&period=annual&limit=5`, fmpKey, ticker),
    fmpGet(`/cash-flow-statement?symbol=${sym}&period=annual&limit=5`, fmpKey, ticker),
    fmpGet(`/analyst-estimates?symbol=${sym}&period=annual&limit=4`, fmpKey, ticker),
    fmpGet(`/discounted-cash-flow?symbol=${sym}`, fmpKey, ticker),
    fetchNews(sym, (path) => fmpGet(path, fmpKey, ticker)),
    fmpGet(stockOld, fmpKey, ticker),
    fmpGet(stockNew, fmpKey, ticker),
    fmpGet(indexOld, fmpKey, ticker),
    fmpGet(indexNew, fmpKey, ticker),
    fmpGet(`/financial-scores?symbol=${sym}`, fmpKey, ticker),
    fmpGet(`/price-target-summary?symbol=${sym}`, fmpKey, ticker),
    fmpGet(`/grades?symbol=${sym}`, fmpKey, ticker),
  ]);
  const priceStock = mergePriceResults(priceStockOld, priceStockNew);
  const priceIndex = mergePriceResults(priceIndexOld, priceIndexNew);
  // Ein einziger ungueltiger Key betrifft alle Aufrufe gleichermassen (selber
  // Key fuer alle) - ein Treffer reicht, um den Lauf als Key-Fehler statt als
  // Datenluecke einzuordnen. Die News (fetchNews) zaehlen bewusst NICHT mit:
  // eine Verweigerung dort (HTTP 401/402/403) ergibt news_status "blocked",
  // die Analyse laeuft weiter.
  const fmpAuthError = fmpAuthErrorExcludingNews({
    profile, peers, income, balance, cashflow, estimates, dcf, priceStock, priceIndex, scores, priceTargetSummary, grades,
  });
  // computeScores() erwartet die News in der Form eines FMP-Ergebnisses.
  const newsForScoring = { ok: true, data: news.items };
  // Rohe Einzelantworten fuer die Einordnung von Fehlschlaegen (Rate-Limit,
  // Plan, Stoerung) - die zusammengefuehrten Kursreihen verdecken z. B. ein
  // 429 in nur einem Fenster.
  const raw = {
    profile, peers, income, balance, cashflow, estimates, dcf,
    priceStockOld, priceStockNew, priceIndexOld, priceIndexNew, scores, priceTargetSummary, grades,
  };
  return { ticker, profile, peers, income, balance, cashflow, estimates, dcf, news: newsForScoring, newsStatus: news.status, newsSource: news.source, priceStock, priceIndex, scores, priceTargetSummary, grades, fmpAuthError, raw };
}

// ---------- Der komplette Analyse-Lauf (laeuft im Hintergrund weiter) ----------
async function runAnalysis(
  ticker: string,
  logId: string,
  startedAt: number,
  userId: string,
  fmpKey: string,
  provider: LlmProvider,
  llmApiKey: string,
  llmModel: string | null,
  adminContext: string | null,
  // Lag beim Start eine gueltige Analyse vor (status "done" mit Gesamtscore)?
  // Im Handler VOR dem Setzen von last_run_status ermittelt. Dann ersetzt
  // nur ein erfolgreicher Lauf die Daten, ein Fehlschlag laesst sie stehen.
  hadValidAnalysis: boolean,
) {
  // Log-Marker fuer Pruefpunkt 3 ("Logs nach dem ersten Testlauf ansehen"):
  // Wenn diese Zeile in Supabase -> Edge Functions -> Logs auftaucht, NACHDEM
  // der Response laengst beim Client angekommen ist, laeuft waitUntil() wie
  // erwartet im Hintergrund weiter.
  console.log(`[analyse] background run started ticker=${ticker} logId=${logId}`);

  try {
    const fmpData = await fetchFmpData(ticker, fmpKey);
    if (fmpData.fmpAuthError) {
      // Bewusst hier abbrechen statt mit leeren/teilweisen FMP-Daten
      // weiterzurechnen - der bestehende catch-Block unten setzt damit
      // status:"error" mit klarer Meldung statt data_quality:"limited".
      throw new Error("FMP-API-Key ungültig oder abgelaufen.");
    }
    // Rate-Limit bei irgendeinem FMP-Aufruf: abbrechen statt mit Luecken
    // weiterzurechnen (der Batch wartet dann und wiederholt den Ticker).
    const rateLimited = rateLimitAbort(fmpData.raw);
    if (rateLimited) throw rateLimited;
    // Profil fehlt: FMP antwortet auf einen nicht existierenden Ticker mit
    // HTTP 200 und einem LEEREN Array (Junk-Ticker wie "WALLETUSD", siehe
    // Pentest-Testfeedback) - ohne Abbruch liefe die Berechnung mit lauter
    // nulls durch. Plan (402), Rate-Limit (429), Stoerung (5xx) und Netz
    // werden dabei getrennt benannt statt pauschal "existiert vermutlich
    // nicht" (siehe _shared/fmpStatus.ts).
    const noProfile = profileAbort(fmpData.profile);
    if (noProfile) throw noProfile;
    const scoreData = computeScores(fmpData);
    if (!scoreData.profile) throw profileAbort({ ok: true, data: [] })!;

    const stability = computeStabilityScore(
      fmpData.scores,
      scoreData.debtRatioAmpel,
      scoreData.dynVerschuldungAmpel,
      scoreData.fcfTrendAmpel,
    );

    const incomeRowsForShares = arr(fmpData.income).slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
    const lastKnownShares = incomeRowsForShares.length
      ? incomeRowsForShares[incomeRowsForShares.length - 1].weightedAverageShsOutDil ?? null
      : null;
    const sharesOutForPrognose = scoreData.profile?.sharesOutstanding ?? lastKnownShares ?? null;

    const prognose = computePrognose(
      fmpData,
      scoreData.profile?.price ?? null,
      sharesOutForPrognose,
    );

    const valuation = computeValuation(
      scoreData.fundamentalSeries,
      scoreData.priceMonthly.stock,
      scoreData.profile?.price ?? null,
      scoreData.dcf?.dcf ?? null,
    );
    const analystConsensus = computeAnalystConsensus(fmpData.priceTargetSummary);
    const bankRatings = computeBankRatings(fmpData.grades);

    // ---------- QUICK-CHECK-VORFILTER ----------
    // Schwellenwerte (Penny-Stock < $5, Liquiditaet < 200k Stueck/Tag,
    // Marktkap-Grenzen) sind eigene, grobe Standard-Setzungen - keine FMP- oder
    // regulatorische Vorgabe, bei Bedarf anpassen.
    const currentPriceForCheck = scoreData.profile?.price ?? null;
    const marketCapForCheck = valuation.verfuegbar ? valuation.market_cap : null;
    const quickCheck = {
      kein_penny_stock: {
        pass: currentPriceForCheck != null ? currentPriceForCheck >= 5 : null,
        wert: currentPriceForCheck,
      },
      liquiditaet: {
        pass: scoreData.avgVolume != null ? scoreData.avgVolume >= 200_000 : null,
        wert: scoreData.avgVolume,
      },
      marktkap_klasse: marketCapForCheck != null
        ? {
          pass: true,
          klasse: marketCapForCheck >= 10_000_000_000 ? "Large Cap" : marketCapForCheck >= 2_000_000_000 ? "Mid Cap" : "Small Cap",
          wert: marketCapForCheck,
        }
        : { pass: null, klasse: null, wert: null },
      aufwaertstrend: {
        pass: scoreData.trend.wCagrStock != null ? scoreData.trend.wCagrStock > 0 : null,
        wert: scoreData.trend.wCagrStock,
      },
    };

    // Fehlt Fundamental, Krise oder Trend schon jetzt, gibt es ohnehin keinen
    // Gesamtscore: Claude-Aufruf sparen und den Lauf hier beenden.
    const incomplete = preLlmAbort({
      scores: { fundamental: scoreData.fundamental.score, krise: scoreData.krise.score, trend: scoreData.trend.score },
      fundamentalResults: [fmpData.income, fmpData.balance, fmpData.cashflow],
      stockPriceResults: [fmpData.raw.priceStockOld, fmpData.raw.priceStockNew],
    });
    if (incomplete) throw incomplete;

    const userPrompt = buildUserPrompt(scoreData, adminContext);
    if (adminContext) {
      console.log(`[analyse] admin_chat_context attached ticker=${ticker} contextChars=${adminContext.length} promptChars=${userPrompt.length}`);
    }
    const llmCallStart = Date.now();
    const llmResult = await callLLM({ provider, apiKey: llmApiKey, model: llmModel, systemPrompt: SYSTEM_PROMPT, userPrompt });
    const parsed = parseAnalysisResult(llmResult);
    const recoveryRuns = [parsed.embeddedRecovery];
    await logApiCall({
      functionName: "analyse",
      provider,
      callType: "qualitaet-analyse",
      ticker,
      success: !parsed.parseError,
      durationMs: Date.now() - llmCallStart,
      tokensInput: parsed.tokensInput,
      tokensOutput: parsed.tokensOutput,
      costUsd: parsed.costUsd,
      errorMessage: parsed.parseError,
      stopReason: llmResult.stopReason,
      model: llmResult.responseModel,
    });

    const scoreFundamental = scoreData.fundamental.score;
    const scoreKrise = scoreData.krise.score;
    const scoreTrend = scoreData.trend.score;
    let scoreQualitaet = parsed.scoreQualitaet;
    let swot = parsed.swot;
    let noGoHart = parsed.noGoHart;
    let fazit = parsed.fazit;
    let firmenbeschreibungDe = parsed.firmenbeschreibungDe;
    let scoreTotal: number | null = null;
    if ([scoreFundamental, scoreQualitaet, scoreKrise, scoreTrend].every((x) => typeof x === "number")) {
      scoreTotal = Math.round(0.35 * scoreFundamental! + 0.25 * scoreQualitaet! + 0.20 * scoreKrise! + 0.20 * scoreTrend!);
    }

    let allCriteria = [
      ...scoreData.fundamental.kriterien.map((k: any) => ({ dimension: "Fundamental", ...k })),
      ...parsed.qualitaetKriterien,
      ...scoreData.trend.kriterien.map((k: any) => ({
        dimension: "Trend", name: k.name, ampel: ampelLabel(k.a),
        begruendung: k.a === null
          ? "Kennzahl nicht berechenbar (fehlende Datengrundlage)."
          : "Kennzahl: " + (k.wert?.toFixed ? k.wert.toFixed(3) : k.wert ?? "n/a"),
      })),
    ];
    if (scoreQualitaet === null && !parsed.parseError) {
      console.warn(`[analyse] LLM call succeeded but scoreQualitaet is null for ${ticker} — kriterien may be missing from tool_use input`);
    }
    // Reines Diagnose-Logging: ein Fehler hier darf die Analyse nie abbrechen
    // (der aeussere catch wuerde die Zeile leeren) - daher alles gekapselt.
    try {
      const anomaly = detectLlmAnomaly({
        ticker,
        provider,
        callType: "qualitaet-analyse",
        model: llmResult.responseModel ?? llmModel,
        stopReason: llmResult.stopReason ?? null,
        toolInput: llmResult.toolInput,
        scoreQualitaet,
        missingScoreParts: listMissingScoreParts({
          fundamental: scoreFundamental,
          qualitaet: scoreQualitaet,
          krise: scoreKrise,
          trend: scoreTrend,
        }),
        parseError: parsed.parseError,
        recovery: parsed.embeddedRecovery,
      });
      if (anomaly) {
        await logAppEvent({
          eventType: "llm_output_anomaly",
          functionName: "analyse",
          status: "suspicious",
          userId,
          details: anomaly.details,
        });
      }
    } catch (e) {
      console.error("[analyse] anomaly logging failed (ignored):", (e as Error).message);
    }
    let warnings = [...scoreData.warningsNumerisch, ...parsed.warnings];
    let tokensInput = parsed.tokensInput, tokensOutput = parsed.tokensOutput, costUsd = parsed.costUsd;

    const ipoDate = scoreData.profile?.ipoDate;
    if (ipoDate) {
      const ageYears = (Date.now() - new Date(ipoDate).getTime()) / (365.25 * 24 * 3600 * 1000);
      if (ageYears < 2) {
        warnings.push("Kurshistorie unter 2 Jahren - Aktie hat noch keine echte Krise durchlaufen, Belastbarkeit der Bewertung entsprechend vorsichtig einordnen.");
      } else if (ageYears < 5) {
        warnings.push("Kurshistorie unter 5 Jahren - Krisenstabilität und Trend eingeschränkt belastbar.");
      }
    }

    const dataSource = (scoreData.dataAvailability.priceStock < 500 || scoreData.dataAvailability.estimates === 0)
      ? "fmp_free_limited" : "fmp_full";

    // ---------- Plausibilitaetspruefung ----------
    const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const { data: historyRows } = await supabase
      .from("request_log")
      .select("score_total, requested_at")
      .eq("ticker", ticker)
      .eq("status", "done")
      .gte("requested_at", cutoff)
      .order("requested_at", { ascending: false })
      .limit(10);

    const history = (historyRows || []).filter((r: any) => typeof r.score_total === "number");
    const historyN = history.length;
    const historyAvg = historyN > 0 ? history.reduce((s: number, r: any) => s + r.score_total, 0) / historyN : null;
    const deviation = historyAvg !== null && typeof scoreTotal === "number" ? scoreTotal - historyAvg : null;
    const needsCheck = historyN >= 2 && deviation !== null && Math.abs(deviation) > 3;

    if (needsCheck) {
      console.log(`[analyse] deviation check triggered ticker=${ticker} deviation=${deviation?.toFixed(1)} historyAvg=${historyAvg?.toFixed(1)} historyN=${historyN}`);
      // Kontrolllauf nutzt bei Claude weiterhin fest "claude-opus-5" -
      // unabhaengig davon, welches Claude-Modell der Nutzer als primaeres
      // hinterlegt hat (Bestandsverhalten). Fuer die drei anderen Anbieter
      // gibt es kein editorial festgelegtes "staerkeres" Modell - der
      // Kontrolllauf wiederholt dort bewusst mit demselben Modell, statt
      // einen moeglicherweise ungueltigen/anderen Modellnamen zu raten.
      const controlModel = provider === "claude" ? "claude-opus-5" : llmModel;
      const llmCallStart2 = Date.now();
      const llmResult2 = await callLLM({ provider, apiKey: llmApiKey, model: controlModel, systemPrompt: SYSTEM_PROMPT, userPrompt });
      const parsed2 = parseAnalysisResult(llmResult2);
      recoveryRuns.push(parsed2.embeddedRecovery);
      await logApiCall({
        functionName: "analyse",
        provider,
        callType: "qualitaet-analyse-kontrolle",
        ticker,
        success: !parsed2.parseError,
        durationMs: Date.now() - llmCallStart2,
        tokensInput: parsed2.tokensInput,
        tokensOutput: parsed2.tokensOutput,
        costUsd: parsed2.costUsd,
        errorMessage: parsed2.parseError,
        stopReason: llmResult2.stopReason,
        model: llmResult2.responseModel,
      });
      try {
        const anomaly2 = detectLlmAnomaly({
          ticker,
          provider,
          callType: "qualitaet-analyse-kontrolle",
          model: llmResult2.responseModel ?? controlModel,
          stopReason: llmResult2.stopReason ?? null,
          toolInput: llmResult2.toolInput,
          scoreQualitaet: parsed2.scoreQualitaet,
          missingScoreParts: listMissingScoreParts({
            fundamental: scoreFundamental,
            qualitaet: parsed2.scoreQualitaet,
            krise: scoreKrise,
            trend: scoreTrend,
          }),
          parseError: parsed2.parseError,
          recovery: parsed2.embeddedRecovery,
        });
        if (anomaly2) {
          await logAppEvent({
            eventType: "llm_output_anomaly",
            functionName: "analyse",
            status: "suspicious",
            userId,
            details: anomaly2.details,
          });
        }
      } catch (e) {
        console.error("[analyse] anomaly logging (Kontrolllauf) failed (ignored):", (e as Error).message);
      }
      const scoreQualitaet2 = parsed2.scoreQualitaet ?? scoreQualitaet;
      let scoreTotal2 = scoreTotal;
      if ([scoreFundamental, scoreQualitaet2, scoreKrise, scoreTrend].every((x) => typeof x === "number")) {
        scoreTotal2 = Math.round(0.35 * scoreFundamental! + 0.25 * scoreQualitaet2! + 0.20 * scoreKrise! + 0.20 * scoreTrend!);
      }
      const avgRounded = Math.round(historyAvg! * 10) / 10;
      const dev1Rounded = Math.round(deviation! * 10) / 10;
      const dev2 = typeof scoreTotal2 === "number" ? Math.round((scoreTotal2 - historyAvg!) * 10) / 10 : null;

      const notes = [
        `Score weicht vom Durchschnitt der letzten ${historyN} Durchläufe (Ø ${avgRounded}, 4 Wochen) um ${dev1Rounded} Punkte ab. Automatischer Kontrolldurchlauf wurde durchgeführt.`,
      ];
      notes.push(
        dev2 !== null && Math.abs(dev2) <= 3
          ? `Kontrolldurchlauf lag mit Score ${scoreTotal2} wieder im erwarteten Bereich - ursprüngliche Abweichung wird als normale Bewertungsschwankung eingeordnet.`
          : `Kontrolldurchlauf bestätigt mit Score ${scoreTotal2} eine deutliche Abweichung vom bisherigen Durchschnitt - möglicherweise eine reale Veränderung der Faktenlage statt reinen Bewertungsrauschens.`,
      );

      // Nur ersetzen, wenn Opus tatsaechlich Kriterien geliefert hat - bei
      // einem JSON-Parse-Fehler im Kontrolllauf waere qualitaetKriterien
      // sonst leer und wuerde die guten Sonnet-Kriterien komplett loeschen.
      allCriteria = parsed2.qualitaetKriterien.length > 0
        ? [...allCriteria.filter((c) => c.dimension !== "Qualitaet"), ...parsed2.qualitaetKriterien]
        : allCriteria;
      warnings = [...warnings, ...(parsed2.warnings ?? []), ...notes];
      scoreQualitaet = scoreQualitaet2;
      scoreTotal = scoreTotal2;
      swot = parsed2.swot;
      noGoHart = parsed2.noGoHart;
      fazit = parsed2.fazit ?? fazit;
      firmenbeschreibungDe = parsed2.firmenbeschreibungDe ?? firmenbeschreibungDe;
      tokensInput += parsed2.tokensInput;
      tokensOutput += parsed2.tokensOutput;
      costUsd += parsed2.costUsd;
    }

    const missingScoreParts = scoreTotal === null
      ? [
          scoreFundamental === null ? "Fundamental" : null,
          scoreQualitaet === null ? "Qualitaet" : null,
          scoreKrise === null ? "Krise" : null,
          scoreTrend === null ? "Trend" : null,
        ].filter(Boolean)
      : [];
    const isComplete = scoreTotal !== null;
    if (!isComplete) {
      console.warn(`[analyse] score_total is null for ${ticker}, missing: ${missingScoreParts.join(", ")} — marking as error instead of done`);
    }

    const result = {
      status: isComplete ? "done" : "error",
      company_name: scoreData.profile?.companyName ?? null,
      sector: scoreData.profile?.sector ?? null,
      currency: scoreData.profile?.currency ?? null,
      current_price: scoreData.profile?.price ?? null,
      score_total: scoreTotal,
      score_fundamental: scoreFundamental !== null ? Math.round(scoreFundamental) : null,
      score_qualitaet: scoreQualitaet !== null ? Math.round(scoreQualitaet) : null,
      score_krise: scoreKrise !== null ? Math.round(scoreKrise) : null,
      score_trend: scoreTrend !== null ? Math.round(scoreTrend) : null,
      score_stabilitaet: stability.score,
      criteria: allCriteria,
      warnings,
      fazit,
      bewertung: { dcf: scoreData.dcf, valuation },
      prognose: prognose,
      chart_data: {
        krise: scoreData.krise.crisisDetail,
        trend: { wCagrStock: scoreData.trend.wCagrStock, wCagrIndex: scoreData.trend.wCagrIndex, wVola: scoreData.trend.wVola },
        stabilitaet: stability.detail,
        swot,
        no_go_hart: noGoHart,
        fundamentalSeries: scoreData.fundamentalSeries,
        priceMonthly: scoreData.priceMonthly,
        relativeStrength: scoreData.relativeStrength,
        returnBars: scoreData.returnBars,
        quickCheck,
        // Datenlage dieses Laufs, nur zur Kennzeichnung, ohne Einfluss auf
        // Score, Status oder Cache.
        data_flags: buildDataFlags({
          newsStatus: fmpData.newsStatus,
          newsSource: fmpData.newsSource,
          availability: scoreData.dataAvailability,
          balanceRows: arr(fmpData.balance),
          incomeRows: arr(fmpData.income),
          llmRecovered: llmRecoveredFrom(recoveryRuns),
        }),
        analystConsensus,
        bankRatings,
        // Fuer den Analysten-Memo-Kopfbereich: alles bereits im selben
        // /profile-Aufruf enthalten, kein zusaetzlicher FMP-Call noetig.
        // defaultImage=true heisst FMP liefert nur ein generisches
        // Platzhalterbild, kein echtes Firmenlogo - dann image weglassen.
        profileMeta: {
          image: scoreData.profile?.defaultImage === true ? null : scoreData.profile?.image ?? null,
          marketCap: scoreData.profile?.marketCap ?? null,
          exchange: scoreData.profile?.exchange ?? null,
          industry: scoreData.profile?.industry ?? null,
          // Deutsche Uebersetzung, vom aktiven LLM-Anbieter im selben
          // Analyse-Call erstellt (siehe _shared/llm/prompt.ts) - kein
          // zusaetzlicher API-Call. Fallback auf die rohe englische FMP-
          // Beschreibung nur, falls der Tool-Aufruf ausnahmsweise keine
          // Uebersetzung geliefert hat (z.B. Parse-Fehler) - besser eine
          // englische Anzeige als keine.
          description: firmenbeschreibungDe || scoreData.profile?.description || null,
        },
      },
      data_source: dataSource,
      error_message: parsed.parseError || (isComplete ? null : `Gesamtscore nicht berechenbar (fehlend: ${missingScoreParts.join(", ")}).`),
      error_message_public: isComplete
        ? null
        : "Die Analyse konnte nicht vollständig berechnet werden. Bitte versuche es erneut.",
    };

    await updateAnalysisRow(
      isComplete ? "Ergebnis" : hadValidAnalysis ? "unvollstaendig, alte Analyse bleibt" : "unvollstaendig",
      ticker,
      completionPatch(result, isComplete, hadValidAnalysis),
    );
    await writeLastRunError(ticker, isComplete ? null : result.error_message);

    // Kosten/Token-Zahlen bewusst NICHT im geteilten stock_analyses-Cache
    // (siehe migrations/20260924120000_hide_stock_analyses_costs.sql,
    // Pentest-Fix) - eigene admin-only Tabelle statt allen Nutzern
    // sichtbarer Spalten.
    await checkedWrite("stock_analyses_costs", ticker, supabase.from("stock_analyses_costs").upsert({
      ticker,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      cost_usd_claude: Math.round(costUsd * 1_000_000) / 1_000_000,
      updated_at: new Date().toISOString(),
    }));

    await checkedWrite("request_log", ticker, supabase.from("request_log").update({
      status: result.error_message ? "error" : "done",
      duration_ms: Date.now() - startedAt,
      error_message: result.error_message,
      data_quality: dataSource === "fmp_full" ? "full" : "limited",
      score_total: result.score_total,
      score_fundamental: result.score_fundamental,
      score_qualitaet: result.score_qualitaet,
      score_krise: result.score_krise,
      score_trend: result.score_trend,
      score_stabilitaet: result.score_stabilitaet,
      deviation_triggered: needsCheck,
      deviation_amount: deviation !== null ? Math.round(deviation * 10) / 10 : null,
    }).eq("id", logId));

    console.log(`[analyse] background run finished ticker=${ticker} logId=${logId} status=${result.status} keptValid=${!isComplete && hadValidAnalysis} durationMs=${Date.now() - startedAt}`);
  } catch (e) {
    console.error(`[analyse] background run FAILED ticker=${ticker} logId=${logId}:`, e);
    // Ohne gueltige Analyse wie bisher: status "error", Score/Kriterien/Fazit
    // MIT zuruecksetzen. stock_analyses ist eine Zeile pro Ticker, die per
    // UPDATE geschrieben wird - sonst blieb bei einem fehlgeschlagenen
    // ERNEUTEN Lauf ein alter Score neben status "error" stehen (reales
    // Nutzerfeedback: NVDA zeigte "Fehler" UND Score 70 in "Letzte
    // Analysen"). status "error" heisst immer "kein verwertbares Ergebnis".
    // Mit gueltiger Analyse (Ticket f) bleibt sie dagegen vollstaendig
    // erhalten (status "done"), nur last_run_* zeigt den Fehlschlag.
    const message = (e as Error).message;
    // AnalysisAbort traegt schon eine fertige Nutzer-Meldung (FMP-Status,
    // fehlende Teilscores), alles andere wird wie bisher klassifiziert.
    const publicMessage = e instanceof AnalysisAbort ? message : classifyErrorForUser(message, provider);
    await updateAnalysisRow(
      hadValidAnalysis ? "Fehlschlag, alte Analyse bleibt" : "Fehlschlag",
      ticker,
      failurePatch(hadValidAnalysis, message, publicMessage, errorCodeFor(e)),
    );
    await writeLastRunError(ticker, message);
    await checkedWrite("request_log", ticker, supabase.from("request_log").update({
      status: "error", duration_ms: Date.now() - startedAt, error_message: message,
    }).eq("id", logId));
    // llm_provider mitloggen - bei Fehlern sofort erkennbar, welcher
    // Anbieter betroffen war (Pentest-Scratchpad-Muster, siehe Migration
    // 20260924100500).
    await logFunctionError("analyse", userId, (e as Error).message, provider);
  }
}

// Code fuer last_run_error_code bei Exceptions, die kein AnalysisAbort sind
// (praktisch: Fehler des LLM-Anbieters). FMP-Key-Fehler bleiben erkennbar.
function errorCodeFor(e: unknown): RunErrorCode {
  if (e instanceof AnalysisAbort) return e.code;
  const msg = (e as Error).message ?? "";
  if (msg === "FMP-API-Key ungültig oder abgelaufen.") return "fmp_auth";
  const lower = msg.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) return "llm_rate_limit";
  return "llm_error";
}

function jsonResponse(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------- HTTP-Handler ----------
Deno.serve(async (req) => {
  const corsHeaders = corsFor(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  const auth = await verifyUser(req);
  if ("error" in auth) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const user_id = auth.userId;

  const body = await req.json().catch(() => ({}));
  const ticker = (body.ticker || "").toString().trim().toUpperCase();
  const max_age_days = body.max_age_days ?? 7;
  const force_refresh = body.force_refresh === true;

  if (!ticker) {
    return new Response(JSON.stringify({ error: "ticker fehlt im Request-Body" }), { status: 400, headers: corsHeaders });
  }

  // Optionaler Kontext aus dem Admin-Chat. stock_analyses ist ein von ALLEN
  // Nutzern geteilter Cache - freier Text im Prompt waere sonst ein Weg, fuer
  // alle sichtbare Analysen zu beeinflussen. Daher nur fuer Admins, und nur
  // in Verbindung mit force_refresh (bei einem Cache-Treffer wuerde der
  // Kontext sonst stillschweigend verworfen).
  let adminContext: string | null = null;
  if (typeof body.admin_chat_context === "string" && body.admin_chat_context.trim()) {
    const admin = await requireAdmin(user_id);
    if (!admin.ok) {
      return new Response(JSON.stringify({ error: admin.error }), {
        status: admin.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!force_refresh) {
      return new Response(JSON.stringify({ error: "admin_chat_context erfordert force_refresh=true." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    adminContext = body.admin_chat_context.trim().slice(-MAX_ADMIN_CONTEXT_CHARS);
  }

  const { data: existingRows, error: existingError } = await supabase.from("stock_analyses").select("*").eq("ticker", ticker).limit(1);
  if (existingError) {
    // Ohne den bisherigen Stand laesst sich nicht entscheiden, ob eine
    // gueltige Analyse geschuetzt werden muss - dann lieber nicht starten.
    console.error(`[analyse] DB-Lesefehler (stock_analyses) ticker=${ticker}: ${existingError.message}`);
    return new Response(JSON.stringify({ error: "Analyse konnte nicht gestartet werden. Bitte erneut versuchen." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const existing = existingRows?.[0] ?? null;

  // Gueltige Analyse = status "done" mit Gesamtscore. Hier ermittelt, bevor
  // der Lauf last_run_status setzt, und an runAnalysis() durchgereicht.
  const hadValidAnalysis = hasValidAnalysis(existing);
  const isFresh = !force_refresh && isCacheFresh(existing, max_age_days, Date.now());

  // Cache-Treffer brauchen keinen externen API-Aufruf und damit auch
  // keinen eigenen Key - nur der "processing"-Pfad unten (echter neuer
  // Lauf) verbraucht FMP/Claude-Kontingent des Nutzers.
  if (isFresh) {
    await checkedWrite("request_log", ticker, supabase.from("request_log").insert({ ticker, user_id, source: "cache", max_age_days, force_refresh }));
    return new Response(JSON.stringify({ source: "cache", ticker, analysis: existing }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Doppellauf: laeuft fuer den Ticker schon ein Lauf (juenger als 5 Min.),
  // nicht parallel starten. Vor dem Rate-Limit, damit die Absage nicht
  // mitzaehlt. Eigener Status 409 + code, der Batch wertet das als
  // "uebersprungen". Das atomare Belegen unten faengt gleichzeitige Anfragen ab.
  const alreadyRunning = () =>
    jsonResponse({ error: `Analyse für ${ticker} läuft bereits.`, code: "already_running" }, 409, corsHeaders);
  if (isRunActive(existing, Date.now())) return alreadyRunning();

  // Rate-Limit NUR fuer echte neue Laeufe (Audit M10) - ein Cache-Treffer
  // oben verbraucht kein FMP-/Claude-Kontingent und zaehlt deshalb bewusst
  // nicht mit. Schuetzt vor versehentlichem oder absichtlichem Ueberlasten
  // des eigenen FMP-Tageskontingents/der Claude-Kosten durch wiederholte
  // force_refresh-Aufrufe, nicht primaer vor fremden Nutzern (die sowieso
  // ihren eigenen Key brauchen).
  if (!(await checkUserRateLimit(user_id, "analyse", MAX_ANALYSES_PER_HOUR))) {
    return jsonResponse(
      { error: `Zu viele neue Analysen (max. ${MAX_ANALYSES_PER_HOUR}/Stunde). Bitte spaeter erneut versuchen.`, code: "rate_limit" },
      429,
      corsHeaders,
    );
  }

  // Eigene Keys laden, BEVOR irgendetwas in der DB angelegt/veraendert wird
  // (stock_analyses/request_log) - sauberer Fehlschlag ohne Seiteneffekte,
  // kein Ticker bleibt auf "running" haengen. Kein Rueckfall auf einen
  // Service-Key, wenn einer der beiden Keys fehlt. LLM-Key/-Modell kommt
  // vom AKTIVEN Anbieter des Nutzers (profiles.active_llm_provider,
  // Default 'claude') statt fest von Claude - siehe _shared/userKeys.ts.
  const { fmpKey } = await loadUserApiKeys(user_id);
  const { provider, apiKey: llmApiKey, model: llmModel } = await loadActiveLlmKey(user_id);
  if (!fmpKey || !llmApiKey) {
    const missing = [!fmpKey ? "FMP" : null, !llmApiKey ? PROVIDER_LABELS[provider] : null].filter(Boolean);
    return new Response(
      JSON.stringify({ error: `Bitte hinterlege zuerst deinen eigenen ${missing.join("-/")}-API-Key in den Einstellungen.` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Lauf als "running" markieren (legt die Zeile an, falls sie noch nicht
  // existiert). Mit gueltiger Analyse nur last_run_status/last_run_at, status
  // bleibt "done" - die alte Analyse bleibt waehrend des Laufs sichtbar.
  // Schlaegt das fehl, nicht starten: sonst wartet das Frontend auf einen
  // Lauf, den es nicht erkennen kann.
  const nowMs = Date.now();
  const runStart = startPatch(hadValidAnalysis, new Date(nowMs).toISOString());
  let started: boolean;
  if (existing) {
    // Nur belegen, wenn kein aktiver Lauf eingetragen ist (atomar im UPDATE).
    const { data: claimed, error } = await supabase.from("stock_analyses")
      .update(runStart).eq("ticker", ticker).or(runNotActiveFilter(nowMs)).select("ticker");
    if (error) {
      // Fallback ohne Sperre, damit ein Filterproblem nie alle Laeufe
      // blockiert; die Vorpruefung oben greift weiterhin.
      console.error(`[analyse] DB-Schreibfehler (Start, Sperre) ticker=${ticker}: ${error.message}`);
      started = await updateAnalysisRow("Start ohne Sperre", ticker, runStart);
    } else if (!claimed?.length) {
      return alreadyRunning();
    } else {
      started = true;
    }
  } else {
    const { error } = await supabase.from("stock_analyses").insert({ ticker, ...runStart });
    // 23505: eine parallele Anfrage hat die Zeile gerade angelegt.
    if (error?.code === "23505") return alreadyRunning();
    if (error) console.error(`[analyse] DB-Schreibfehler (Start) ticker=${ticker}: ${error.message}`);
    started = !error;
  }
  if (!started) {
    return new Response(JSON.stringify({ error: "Analyse konnte nicht gestartet werden. Bitte erneut versuchen." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: logRow, error: logError } = await supabase.from("request_log").insert({
    ticker, user_id, source: "processing", max_age_days, force_refresh,
  }).select().single();
  if (logError || !logRow) {
    console.error(`[analyse] DB-Schreibfehler (request_log) ticker=${ticker}: ${logError?.message ?? "keine Zeile"}`);
    await updateAnalysisRow("Start abgebrochen", ticker, failurePatch(hadValidAnalysis, "request_log-Eintrag fehlgeschlagen", null));
    return new Response(JSON.stringify({ error: "Analyse konnte nicht gestartet werden. Bitte erneut versuchen." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const startedAt = Date.now();

  // Log-Marker fuer Pruefpunkt 3: diese Zeile erscheint VOR dem Response.
  console.log(`[analyse] responding immediately, handing off to background ticker=${ticker} logId=${logRow?.id}`);

  // Sofort antworten, danach im Hintergrund weiterlaufen (Supabase-eigenes
  // Aequivalent zum n8n "fire and continue"-Muster).
  // @ts-ignore: EdgeRuntime ist eine Supabase-spezifische globale API
  EdgeRuntime.waitUntil(runAnalysis(ticker, logRow!.id, startedAt, user_id, fmpKey, provider, llmApiKey, llmModel, adminContext, hadValidAnalysis));

  return new Response(JSON.stringify({ source: "processing", ticker, status: "running" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
