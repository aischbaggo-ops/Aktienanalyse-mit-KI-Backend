import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { computeScores, computeStabilityScore, computePrognose, computeValuation, computeAnalystConsensus, computeBankRatings, ampelLabel, arr, first } from "../_shared/scoring.ts";
import { buildUserPrompt, callClaude, parseClaudeResponse, PRICING, QUAL_WEIGHTS } from "../_shared/claude.ts";
import { verifyUser } from "../_shared/auth.ts";
import { loadUserApiKeys } from "../_shared/userKeys.ts";

const FMP_BASE = "https://financialmodelingprep.com/stable";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function fmpGet(path: string, fmpKey: string) {
  try {
    const url = FMP_BASE + path + (path.includes("?") ? "&" : "?") + "apikey=" + fmpKey;
    const res = await fetch(url);
    const data = await res.json();
    // FMP liefert bei ungueltigem/abgelaufenem Key HTTP 401/403 zurueck, aber
    // trotzdem einen normalen JSON-Body - ohne diese Unterscheidung sieht das
    // im weiteren Verlauf wie eine ganz normale Datenluecke aus (z.B.
    // Free-Plan-Limitierung) statt wie ein klar meldbarer Key-Fehler.
    const authError = res.status === 401 || res.status === 403;
    return { ok: res.ok, data, authError };
  } catch (e) {
    return { ok: false, error: (e as Error).message, authError: false };
  }
}

async function fetchFmpData(ticker: string, fmpKey: string) {
  const [profile, peers, income, balance, cashflow, estimates, dcf, news, priceStock, priceIndex, scores, priceTargetSummary, grades] = await Promise.all([
    fmpGet(`/profile?symbol=${ticker}`, fmpKey),
    fmpGet(`/stock-peers?symbol=${ticker}`, fmpKey),
    fmpGet(`/income-statement?symbol=${ticker}&period=annual&limit=5`, fmpKey),
    fmpGet(`/balance-sheet-statement?symbol=${ticker}&period=annual&limit=5`, fmpKey),
    fmpGet(`/cash-flow-statement?symbol=${ticker}&period=annual&limit=5`, fmpKey),
    fmpGet(`/analyst-estimates?symbol=${ticker}&period=annual&limit=4`, fmpKey),
    fmpGet(`/discounted-cash-flow?symbol=${ticker}`, fmpKey),
    fmpGet(`/news/stock?symbols=${ticker}&limit=20`, fmpKey),
    fmpGet(`/historical-price-eod/full?symbol=${ticker}&from=2000-01-01`, fmpKey),
    fmpGet(`/historical-price-eod/full?symbol=%5EGSPC&from=2000-01-01`, fmpKey),
    fmpGet(`/financial-scores?symbol=${ticker}`, fmpKey),
    fmpGet(`/price-target-summary?symbol=${ticker}`, fmpKey),
    fmpGet(`/grades?symbol=${ticker}`, fmpKey),
  ]);
  // Ein einziger ungueltiger Key betrifft alle Aufrufe gleichermassen (selber
  // Key fuer alle) - ein Treffer reicht, um den Lauf als Key-Fehler statt als
  // Datenluecke einzuordnen.
  const fmpAuthError = [profile, peers, income, balance, cashflow, estimates, dcf, news, priceStock, priceIndex, scores, priceTargetSummary, grades].some(
    (r) => r.authError === true,
  );
  return { ticker, profile, peers, income, balance, cashflow, estimates, dcf, news, priceStock, priceIndex, scores, priceTargetSummary, grades, fmpAuthError };
}

// ---------- Der komplette Analyse-Lauf (laeuft im Hintergrund weiter) ----------
async function runAnalysis(ticker: string, logId: string, startedAt: number, fmpKey: string, claudeKey: string) {
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
    const scoreData = computeScores(fmpData);

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

    const userPrompt = buildUserPrompt(scoreData);
    const claudeRaw = await callClaude("claude-sonnet-5", userPrompt, claudeKey);
    const parsed = parseClaudeResponse(claudeRaw);

    const scoreFundamental = scoreData.fundamental.score;
    const scoreKrise = scoreData.krise.score;
    const scoreTrend = scoreData.trend.score;
    let scoreQualitaet = parsed.scoreQualitaet;
    let swot = parsed.swot;
    let noGoHart = parsed.noGoHart;
    let fazit = parsed.fazit;
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
      const claudeRaw2 = await callClaude("claude-opus-5", userPrompt, claudeKey);
      const parsed2 = parseClaudeResponse(claudeRaw2);
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
      tokensInput += parsed2.tokensInput;
      tokensOutput += parsed2.tokensOutput;
      costUsd += parsed2.costUsd;
    }

    const result = {
      status: "done",
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
        },
      },
      data_source: dataSource,
      error_message: parsed.parseError,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      cost_usd_claude: Math.round(costUsd * 1_000_000) / 1_000_000,
    };

    await supabase.from("stock_analyses").update(result).eq("ticker", ticker);

    await supabase.from("request_log").update({
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
    }).eq("id", logId);

    console.log(`[analyse] background run finished ticker=${ticker} logId=${logId} status=${result.status} durationMs=${Date.now() - startedAt}`);
  } catch (e) {
    console.error(`[analyse] background run FAILED ticker=${ticker} logId=${logId}:`, e);
    await supabase.from("stock_analyses").update({ status: "error", error_message: (e as Error).message }).eq("ticker", ticker);
    await supabase.from("request_log").update({
      status: "error", duration_ms: Date.now() - startedAt, error_message: (e as Error).message,
    }).eq("id", logId);
  }
}

// ---------- HTTP-Handler ----------
Deno.serve(async (req) => {
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

  const { data: existingRows } = await supabase.from("stock_analyses").select("*").eq("ticker", ticker).limit(1);
  const existing = existingRows?.[0] ?? null;

  let isFresh = false;
  if (existing && existing.status === "done" && !force_refresh) {
    const ageMs = Date.now() - new Date(existing.updated_at).getTime();
    isFresh = ageMs <= max_age_days * 24 * 60 * 60 * 1000;
  }

  // Cache-Treffer brauchen keinen externen API-Aufruf und damit auch
  // keinen eigenen Key - nur der "processing"-Pfad unten (echter neuer
  // Lauf) verbraucht FMP/Claude-Kontingent des Nutzers.
  if (isFresh) {
    await supabase.from("request_log").insert({ ticker, user_id, source: "cache", max_age_days, force_refresh });
    return new Response(JSON.stringify({ source: "cache", ticker, analysis: existing }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Eigene Keys laden, BEVOR irgendetwas in der DB angelegt/veraendert wird
  // (stock_analyses/request_log) - sauberer Fehlschlag ohne Seiteneffekte,
  // kein Ticker bleibt auf "running" haengen. Kein Rueckfall auf einen
  // Service-Key, wenn einer der beiden Keys fehlt.
  const { fmpKey, claudeKey } = await loadUserApiKeys(user_id);
  if (!fmpKey || !claudeKey) {
    return new Response(
      JSON.stringify({ error: "Bitte hinterlege zuerst deinen eigenen FMP-/Claude-API-Key in den Einstellungen." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Status auf running setzen (legt Zeile an, falls sie noch nicht existiert)
  if (existing) {
    await supabase.from("stock_analyses").update({ status: "running" }).eq("ticker", ticker);
  } else {
    await supabase.from("stock_analyses").insert({ ticker, status: "running" });
  }

  const { data: logRow } = await supabase.from("request_log").insert({
    ticker, user_id, source: "processing", max_age_days, force_refresh,
  }).select().single();

  const startedAt = Date.now();

  // Log-Marker fuer Pruefpunkt 3: diese Zeile erscheint VOR dem Response.
  console.log(`[analyse] responding immediately, handing off to background ticker=${ticker} logId=${logRow?.id}`);

  // Sofort antworten, danach im Hintergrund weiterlaufen (Supabase-eigenes
  // Aequivalent zum n8n "fire and continue"-Muster).
  // @ts-ignore: EdgeRuntime ist eine Supabase-spezifische globale API
  EdgeRuntime.waitUntil(runAnalysis(ticker, logRow!.id, startedAt, fmpKey, claudeKey));

  return new Response(JSON.stringify({ source: "processing", ticker, status: "running" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
