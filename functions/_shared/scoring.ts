export function ok(x: any) { return x && x.ok && x.data; }
export function arr(x: any) { return ok(x) && Array.isArray(x.data) ? x.data : []; }
export function first(x: any) { const a = arr(x); return a.length ? a[0] : null; }

function series(rows: any[], field: string) {
  return rows.map((r) => (typeof r[field] === "number" ? r[field] : null));
}

function trendAmpel(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && !isNaN(x));
  if (v.length < 2) return null; // GRAU statt 0.5 - echt keine Datengrundlage
  let increases = 0, total = 0;
  for (let i = 1; i < v.length; i++) { total++; if (v[i] > v[i - 1]) increases++; }
  const ratio = increases / total;
  const overallUp = v[v.length - 1] >= v[0];
  if (ratio >= 0.65 && overallUp) return 1;
  if (ratio >= 0.4 || overallUp) return 0.5;
  return 0;
}

function stabilityOrRisingAmpel(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => typeof x === "number" && !isNaN(x));
  if (v.length < 2) return null; // GRAU statt 0.5 - echt keine Datengrundlage
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 1;
  const rising = v[v.length - 1] >= v[0];
  if (cv < 0.15 || rising) return 1;
  if (cv < 0.3) return 0.5;
  return 0;
}

function thresholdAmpel(value: number | null, greenIfBelow: number, yellowIfBelow: number): number | null {
  if (typeof value !== "number" || isNaN(value)) return null; // GRAU
  if (value <= greenIfBelow) return 1;
  if (value <= yellowIfBelow) return 0.5;
  return 0;
}
function thresholdAmpelInverse(value: number | null, greenIfAbove: number, yellowIfAbove: number): number | null {
  if (typeof value !== "number" || isNaN(value)) return null; // GRAU
  if (value >= greenIfAbove) return 1;
  if (value >= yellowIfAbove) return 0.5;
  return 0;
}
export function ampelLabel(a: number | null) {
  if (a === null) return "grau";
  return a === 1 ? "gruen" : a === 0.5 ? "gelb" : "rot";
}
function subScore(pflicht: { a: number | null; w: number }[]): number | null {
  let numerator = 0, denominator = 0;
  for (const { a, w } of pflicht) {
    if (a === null) continue; // GRAU - zaehlt weder im Zaehler noch im Nenner
    numerator += a * w;
    denominator += w;
  }
  if (denominator === 0) return null; // ALLE Kriterien grau -> Score selbst nicht bestimmbar
  return Math.min(100, (numerator / denominator) * 100);
}
// Kombiniert historischen und Prognose-Trend konservativ (Minimum). Fehlt die
// Historie ganz, ist das Kriterium nicht bewertbar (GRAU). Fehlt nur die
// Prognose, faellt das Kriterium auf die reine Historie zurueck.
function combineHistProg(histA: number | null, progA: number | null): number | null {
  if (histA === null) return null;
  if (progA === null) return histA;
  return Math.min(histA, progA);
}

export function computeScores(d: any) {
  const profile = first(d.profile);
  const incomeRaw = arr(d.income).slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const balanceRaw = arr(d.balance).slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const cashflowRaw = arr(d.cashflow).slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const estimatesRaw = arr(d.estimates).slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const dcfData = first(d.dcf);
  const newsRaw = arr(d.news);
  const priceStockRaw = arr(d.priceStock);
  const priceIndexRaw = arr(d.priceIndex);

  const dataAvailability = {
    profile: !!profile, income: incomeRaw.length, balance: balanceRaw.length,
    cashflow: cashflowRaw.length, estimates: estimatesRaw.length, dcf: !!dcfData,
    news: newsRaw.length, priceStock: priceStockRaw.length, priceIndex: priceIndexRaw.length,
  };

  // ---------- FUNDAMENTAL ----------
  const netIncome = series(incomeRaw, "netIncome");
  const revenue = series(incomeRaw, "revenue");
  const operatingMargin = incomeRaw.map((r: any) =>
    typeof r.revenue === "number" && r.revenue !== 0 && typeof r.operatingIncome === "number"
      ? r.operatingIncome / r.revenue : null);
  const freeCashFlow = series(cashflowRaw, "freeCashFlow");
  const sharesOut = series(incomeRaw, "weightedAverageShsOutDil");
  const estNetIncome = series(estimatesRaw, "netIncomeAvg");
  const estRevenue = series(estimatesRaw, "revenueAvg");

  const kriterienFundamental: any[] = [];
  function addF(name: string, haertegrad: string, w: number, a: number | null, begruendung: string, optional = false) {
    kriterienFundamental.push({ name, haertegrad, w, a, ampel: ampelLabel(a), begruendung, optional });
  }

  {
    const histA = trendAmpel(netIncome);
    const progA = estNetIncome.length >= 2 ? trendAmpel(estNetIncome) : histA;
    addF("Gewinne steigen stetig + Prognose 3J", "Normal", 1, combineHistProg(histA, progA),
      `Historischer Trend ${ampelLabel(histA)}, Prognose-Trend ${ampelLabel(progA)}.`);
  }
  let fcfTrendAmpel: number | null = null;
  {
    const histA = trendAmpel(freeCashFlow);
    fcfTrendAmpel = histA;
    addF("Free Cashflows steigen stetig + Prognose 3J", "Streng", 2, histA,
      `Historischer FCF-Trend ${ampelLabel(histA)} (Prognose mangels FMP-Datenfeld nicht separat verfuegbar).`);
  }
  {
    const histA = trendAmpel(revenue);
    const progA = estRevenue.length >= 2 ? trendAmpel(estRevenue) : histA;
    addF("Umsaetze steigen stetig + Prognose 3J", "Normal", 1, combineHistProg(histA, progA),
      `Historischer Trend ${ampelLabel(histA)}, Prognose-Trend ${ampelLabel(progA)}.`);
  }
  {
    const a = stabilityOrRisingAmpel(operatingMargin);
    addF("Operative Marge konstant oder steigend", "Streng", 2, a,
      `Marge-Verlauf ueber ${operatingMargin.filter((x) => x !== null).length} Jahre.`);
  }
  {
    const roicSeries = incomeRaw.map((r: any, i: number) => {
      const bal = balanceRaw[i];
      if (!bal || typeof r.operatingIncome !== "number") return null;
      const taxRate = typeof r.incomeTaxExpense === "number" && typeof r.incomeBeforeTax === "number" && r.incomeBeforeTax !== 0
        ? r.incomeTaxExpense / r.incomeBeforeTax : 0.21;
      const nopat = r.operatingIncome * (1 - taxRate);
      const investedCapital = (bal.totalDebt || 0) + (bal.totalStockholdersEquity || 0) - (bal.cashAndCashEquivalents || 0);
      return investedCapital > 0 ? nopat / investedCapital : null;
    });
    const validRoic = roicSeries.filter((x: number | null) => x !== null) as number[];
    const avgRoic = validRoic.length ? validRoic.reduce((a, b) => a + b, 0) / validRoic.length : null;
    const a = avgRoic !== null ? thresholdAmpelInverse(avgRoic, 0.15, 0.08) : null;
    addF("Kapitalrendite ROIC hoch und stabil", "Normal", 1, a,
      avgRoic !== null ? `Durchschnittlicher ROIC (naeherungsweise) ${(avgRoic * 100).toFixed(1)}%.` : "ROIC mangels Daten nicht berechenbar.");
  }
  {
    const v = sharesOut.filter((x): x is number => typeof x === "number");
    let a: number | null = null;
    if (v.length >= 2) {
      const change = (v[v.length - 1] - v[0]) / v[0];
      a = change <= -0.02 ? 1 : change <= 0.02 ? 0.5 : 0;
    }
    addF("Aktienanzahl-Trend (Rueckkauf gut, Verwaesserung negativ)", "Soft", 0.5, a,
      "Veraenderung der ausstehenden Aktien ueber den verfuegbaren Zeitraum.");
  }

  const debtRatioSeries = balanceRaw.map((b: any) =>
    typeof b.totalLiabilities === "number" && typeof b.totalAssets === "number" && b.totalAssets !== 0
      ? b.totalLiabilities / b.totalAssets : null);
  const latestDebtRatio = debtRatioSeries.filter((x: number | null) => x !== null).slice(-1)[0] ?? null;
  let debtRatioAmpel: number | null = null;
  {
    const a = thresholdAmpel(latestDebtRatio, 0.6, 0.75);
    debtRatioAmpel = a;
    addF("Schuldenquote < 60% (alle Verbindlichkeiten / Bilanzsumme)", "Normal", 1, a,
      latestDebtRatio !== null ? `Aktuelle Schuldenquote ${(latestDebtRatio * 100).toFixed(1)}%.` : "Daten nicht verfuegbar.");
  }
  {
    const declining = trendAmpel(debtRatioSeries.filter((x: number | null) => x !== null).map((x: number) => -x));
    addF("Schuldenquote sinkend", "Normal", 1, declining, "Verlauf der Schuldenquote ueber die verfuegbaren Jahre.");
  }
  let dynVerschuldungKO = false;
  let dynVerschuldungAmpel: number | null = null;
  {
    const lastBal = balanceRaw.slice(-1)[0];
    const lastCf = cashflowRaw.slice(-1)[0];
    let a: number | null = null, dynValue: number | null = null;
    if (lastBal && lastCf && typeof lastCf.freeCashFlow === "number" && lastCf.freeCashFlow > 0) {
      dynValue = ((lastBal.totalDebt || 0) - (lastBal.cashAndCashEquivalents || 0)) / lastCf.freeCashFlow;
      a = thresholdAmpel(dynValue, 5, 10);
      if (dynValue >= 10) dynVerschuldungKO = true;
    }
    dynVerschuldungAmpel = a;
    addF("Dynamischer Verschuldungsgrad < 5 Jahre", "Streng", 2, a,
      dynValue !== null ? `Netto-Schulden / FCF ~ ${dynValue.toFixed(1)} Jahre.` : "Nicht berechenbar (FCF <= 0 oder Daten fehlen).");
  }
  {
    const lastBal = balanceRaw.slice(-1)[0];
    let a: number | null = null, gwRatio: number | null = null;
    if (lastBal && typeof lastBal.goodwill === "number" && typeof lastBal.totalAssets === "number" && lastBal.totalAssets !== 0) {
      gwRatio = lastBal.goodwill / lastBal.totalAssets;
      a = thresholdAmpel(gwRatio, 0.3, 0.45);
    }
    addF("Goodwill-Anteil < 30% (Goodwill / Bilanzsumme)", "Soft", 0.5, a,
      gwRatio !== null ? `Goodwill-Anteil ${(gwRatio * 100).toFixed(1)}%.` : "Nicht verfuegbar.");
  }

  const dividendsPaid = cashflowRaw.map((c: any) => (typeof c.dividendsPaid === "number" ? Math.abs(c.dividendsPaid) : null));
  const isDividendPayer = dividendsPaid.some((x: number | null) => x && x > 0);
  if (isDividendPayer) {
    const last20 = dividendsPaid.slice(-20);
    const gaps = last20.filter((x: number | null) => !x || x === 0).length;
    addF("Dividende stetig, keine Ausfaelle", "Normal", 1, gaps === 0 ? 1 : gaps <= 1 ? 0.5 : 0,
      `${gaps} Jahr(e) ohne Dividende in den letzten ${last20.length} verfuegbaren Jahren.`);

    const lastNI = netIncome.slice(-1)[0];
    const lastDiv = dividendsPaid.slice(-1)[0];
    const payoutNI = lastNI && lastDiv ? lastDiv / lastNI : null;
    addF("Dividende <= Gewinn", "Normal", 1, thresholdAmpel(payoutNI, 0.6, 1.0),
      payoutNI !== null ? `Ausschuettungsquote vs. Gewinn ${(payoutNI * 100).toFixed(0)}%.` : "Nicht berechenbar.");

    const lastFCF = freeCashFlow.slice(-1)[0];
    const payoutFCF = lastFCF && lastDiv ? lastDiv / lastFCF : null;
    addF("Dividende <= Free Cashflow", "Normal", 1, thresholdAmpel(payoutFCF, 0.6, 1.0),
      payoutFCF !== null ? `Ausschuettungsquote vs. FCF ${(payoutFCF * 100).toFixed(0)}%.` : "Nicht berechenbar.");
  }

  const fundamentalPflicht = kriterienFundamental.filter((k) => !k.optional).map((k) => ({ a: k.a, w: k.w }));
  const scoreFundamental = subScore(fundamentalPflicht);

  // ---------- KRISENSTABILITAET ----------
  const stockRows = priceStockRaw.filter((r: any) => r.date && typeof r.close === "number")
    .sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const indexRows = priceIndexRaw.filter((r: any) => r.date && typeof r.close === "number")
    .sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));

  function maxDrawdownInWindow(rows: any[], fromDate: string, toDate: string): number | null {
    const w = rows.filter((r) => r.date >= fromDate && r.date <= toDate);
    if (w.length < 2) return null;
    let peak = w[0].close, maxDD = 0;
    for (const r of w) { if (r.close > peak) peak = r.close; const dd = (peak - r.close) / peak; if (dd > maxDD) maxDD = dd; }
    return maxDD;
  }

  const crises = [
    { name: "Dotcom", from: "2000-01-01", to: "2002-12-31", r: 0.3 },
    { name: "Finanzkrise", from: "2007-10-01", to: "2009-03-31", r: 0.55 },
    { name: "Corona", from: "2020-01-01", to: "2020-12-31", r: 1.0 },
    { name: "Zins/Inflation", from: "2022-01-01", to: "2022-12-31", r: 1.15 },
    { name: "Zoll", from: "2025-01-01", to: "2025-12-31", r: 1.3 },
  ];
  const crisisDetail = crises.map((c) => {
    const ddStock = maxDrawdownInWindow(stockRows, c.from, c.to);
    const ddIndex = maxDrawdownInWindow(indexRows, c.from, c.to);
    let a: number;
    if (ddStock === null || ddIndex === null || ddIndex === 0) { a = 0.5; }
    else { const ratio = ddStock / ddIndex; a = ratio < 0.85 ? 1 : ratio <= 1.2 ? 0.5 : 0; }
    return { ...c, ddStock, ddIndex, a };
  });
  const sumR = crisisDetail.reduce((s, c) => s + c.r, 0);
  const krisenKomponente = crisisDetail.reduce((s, c) => s + c.a * c.r, 0) / sumR;
  const beta = profile && typeof profile.beta === "number" ? profile.beta : null;
  const betaAmpel = beta === null ? null : beta < 1.0 ? 1 : beta <= 1.75 ? 0.5 : 0;
  // Fehlt Beta (GRAU), wird die Krisen-Komponente allein auf 100% gestreckt,
  // statt den 20%-Beta-Anteil stillschweigend als "rot" (0) zu werten.
  const scoreKrise = betaAmpel === null
    ? krisenKomponente * 100
    : (0.8 * krisenKomponente + 0.2 * betaAmpel) * 100;

  // ---------- TREND ----------
  function yearlyReturns(rows: any[]) {
    const byYear = new Map<string, number>();
    for (const r of rows) byYear.set(r.date.slice(0, 4), r.close);
    const years = [...byYear.keys()].sort();
    const out: { year: number; ret: number }[] = [];
    for (let i = 1; i < years.length; i++) {
      const prev = byYear.get(years[i - 1]), curr = byYear.get(years[i]);
      if (prev && curr) out.push({ year: Number(years[i]), ret: curr / prev - 1 });
    }
    return out;
  }
  function recencyFactor(year: number) { const age = new Date().getFullYear() - year; return age <= 10 ? 2 : age <= 20 ? 1 : 0.5; }
  function weightedAvg<T>(items: T[], valueFn: (i: T) => number, weightFn: (i: T) => number): number | null {
    let num = 0, den = 0;
    for (const it of items) { const w = weightFn(it); num += valueFn(it) * w; den += w; }
    return den > 0 ? num / den : null;
  }
  const stockReturns = yearlyReturns(stockRows);
  const indexReturns = yearlyReturns(indexRows);
  const wCagrStock = weightedAvg(stockReturns, (r) => r.ret, (r) => recencyFactor(r.year));
  const wCagrIndex = weightedAvg(indexReturns, (r) => r.ret, (r) => recencyFactor(r.year));
  const wVola = (() => {
    if (!stockReturns.length) return null;
    const mean = weightedAvg(stockReturns, (r) => r.ret, (r) => recencyFactor(r.year))!;
    const variance = weightedAvg(stockReturns, (r) => (r.ret - mean) ** 2, (r) => recencyFactor(r.year));
    return variance !== null ? Math.sqrt(variance) : null;
  })();
  function longestUnderwaterYears(rows: any[]): number | null {
    if (!rows.length) return null;
    let peak = rows[0].close, underwaterStart: Date | null = null, longest = 0;
    for (const r of rows) {
      if (r.close >= peak) {
        peak = r.close;
        if (underwaterStart) { longest = Math.max(longest, (+new Date(r.date) - +underwaterStart) / (365.25 * 24 * 3600 * 1000)); underwaterStart = null; }
      } else if (!underwaterStart) { underwaterStart = new Date(r.date); }
    }
    if (underwaterStart) longest = Math.max(longest, (+new Date(rows[rows.length - 1].date) - +underwaterStart) / (365.25 * 24 * 3600 * 1000));
    return longest;
  }
  const underwaterStock = longestUnderwaterYears(stockRows);
  const underwaterIndex = longestUnderwaterYears(indexRows);
  const underwaterRatio = underwaterStock !== null && underwaterIndex ? underwaterStock / underwaterIndex : null;

  const trendKriterien: any[] = [];
  { const a = wCagrStock === null ? null : wCagrStock > 0.08 ? 1 : wCagrStock >= 0 ? 0.5 : 0;
    trendKriterien.push({ name: "Aufwaertstrend ueber ca. 20 Jahre (zeitgewichtete CAGR)", a, wert: wCagrStock }); }
  { const a = wVola === null ? null : wVola < 0.20 ? 1 : wVola <= 0.35 ? 0.5 : 0;
    trendKriterien.push({ name: "Kontinuitaet (Volatilitaet der Jahresrenditen, zeitgewichtet)", a, wert: wVola }); }
  { let a = underwaterRatio === null ? null : underwaterRatio < 0.8 ? 1 : underwaterRatio <= 1.2 ? 0.5 : 0;
    if (underwaterStock !== null && underwaterStock > 7) a = 0;
    trendKriterien.push({ name: "Laengste Unterwasser-Phase relativ zum S&P", a, wert: underwaterRatio }); }
  { const diff = wCagrStock !== null && wCagrIndex !== null ? wCagrStock - wCagrIndex : null;
    const a = diff === null ? null : diff > 0.01 ? 1 : diff >= -0.01 ? 0.5 : 0;
    trendKriterien.push({ name: "Performance vs. S&P (zeitgewichtete CAGR-Differenz)", a, wert: diff }); }
  const scoreTrend = subScore(trendKriterien.map((k) => ({ a: k.a, w: 1 })));

  const warningsNumerisch: string[] = [];
  if (dynVerschuldungKO) warningsNumerisch.push("Dynamischer Verschuldungsgrad zweistellig (Netto-Schulden/FCF >= 10 Jahre) - Ausschluss-Hinweis.");

  // ---------- FUNDAMENTAL-ZEITREIHEN (fuer Etappe-1-Frontend-Charts) ----------
  // Reine Persistenz/Ableitung bereits abgerufener FMP-Rohdaten, keine neue
  // Bewertungslogik.

  const fundamentalSeries = {
    years: incomeRaw.map((r: any) => (r.date || "").slice(0, 4)),
    // Volles Bilanzstichtags-Datum (nicht nur Jahr) - wird fuer den
    // historischen KGV/KCV-Fair-Value-Vergleich gebraucht, um den Kurs zum
    // jeweiligen Stichtag aus der Monats-Preisreihe nachzuschlagen.
    datesFull: incomeRaw.map((r: any) => r.date || ""),
    revenue,
    grossProfit: series(incomeRaw, "grossProfit"),
    ebit: series(incomeRaw, "operatingIncome"), // EBIT-Naeherung, bereits verifiziertes Feld
    ebitda: series(incomeRaw, "ebitda"),
    netIncome,
    grossMargin: incomeRaw.map((r: any) =>
      typeof r.revenue === "number" && r.revenue !== 0 && typeof r.grossProfit === "number"
        ? r.grossProfit / r.revenue : null),
    operatingMargin,
    netMargin: incomeRaw.map((r: any) =>
      typeof r.revenue === "number" && r.revenue !== 0 && typeof r.netIncome === "number"
        ? r.netIncome / r.revenue : null),
    operatingCashFlow: series(cashflowRaw, "operatingCashFlow"),
    freeCashFlow,
    goodwill: series(balanceRaw, "goodwill"),
    sharesOut,
    totalDebt: series(balanceRaw, "totalDebt"),
    cash: series(balanceRaw, "cashAndCashEquivalents"),
    dividendsPaid: dividendsPaid,
    isDividendPayer,
  };

  // ---------- MONATSKURSREIHEN + RELATIVE STAERKE (fuer Quick-Check-Charts) ----------
  function toMonthlySeries(rows: any[]): { date: string; close: number }[] {
    const byMonth = new Map<string, { date: string; close: number }>();
    for (const r of rows) {
      if (!r.date || typeof r.close !== "number") continue;
      // rows sind aufsteigend sortiert - der letzte Eintrag eines Monats
      // ueberschreibt, damit am Ende der Monats-Schlusskurs steht.
      byMonth.set(r.date.slice(0, 7), { date: r.date, close: r.close });
    }
    return [...byMonth.values()];
  }
  const stockMonthly = toMonthlySeries(stockRows);
  const indexMonthly = toMonthlySeries(indexRows);

  const relativeStrength: { date: string; value: number }[] = [];
  {
    const indexByMonth = new Map(indexMonthly.map((r) => [r.date.slice(0, 7), r.close]));
    let baseRatio: number | null = null;
    for (const s of stockMonthly) {
      const idxClose = indexByMonth.get(s.date.slice(0, 7));
      if (idxClose === undefined || idxClose === 0) continue;
      const ratio = s.close / idxClose;
      if (baseRatio === null) baseRatio = ratio;
      relativeStrength.push({ date: s.date, value: Math.round((ratio / baseRatio) * 10000) / 100 });
    }
  }

  // Durchschnittliches Handelsvolumen (letzte ~90 Handelstage) fuer den
  // Quick-Check "Liquiditaet".
  const recentVolumes = stockRows.slice(-90).map((r: any) => r.volume).filter((v: any) => typeof v === "number");
  const avgVolume = recentVolumes.length ? recentVolumes.reduce((a: number, b: number) => a + b, 0) / recentVolumes.length : null;

  // Symmetrische Gewinn-/Drawdown-Balken: dieselben Jahresrenditen, die auch
  // fuer die zeitgewichtete CAGR verwendet werden (siehe TREND-Abschnitt oben),
  // hier 1:1 als vorzeichenbehaftete Balkenreihe exportiert.
  const returnBars = stockReturns.map((r) => ({ period: String(r.year), pct: Math.round(r.ret * 1000) / 1000 }));

  const profileSummary = profile
    ? `${profile.companyName} (${profile.symbol}), Sektor: ${profile.sector}, Branche: ${profile.industry}, Land: ${profile.country}, IPO: ${profile.ipoDate}, CEO: ${profile.ceo}, Mitarbeiter: ${profile.fullTimeEmployees}. Beschreibung: ${(profile.description || "").slice(0, 800)}`
    : "Kein Firmenprofil verfuegbar.";
  const peersArr = arr(d.peers);
  const peersSummary = peersArr.length ? peersArr.map((p: any) => `${p.symbol} (${p.companyName})`).join(", ") : "Keine Peer-Daten verfuegbar.";
  const newsSummary = newsRaw.length
    ? newsRaw.slice(0, 10).map((n: any) => `- [${n.publishedDate || n.date || ""}] ${n.title || n.text || ""}`).join("\n")
    : "Keine aktuellen News verfuegbar (News-Endpunkt im FMP Free-Plan gesperrt).";

  return {
    ticker: d.ticker,
    dataAvailability,
    profileSummary,
    peersSummary,
    newsSummary,
    fundamental: { score: scoreFundamental, kriterien: kriterienFundamental },
    krise: { score: scoreKrise, komponente: krisenKomponente, beta, betaAmpel, crisisDetail },
    trend: { score: scoreTrend, kriterien: trendKriterien, wCagrStock, wCagrIndex, wVola, underwaterStock, underwaterIndex },
    warningsNumerisch,
    // Bereits berechnete Ampel-Werte, zusaetzlich nach aussen gereicht fuer
    // computeStabilityScore() (siehe unten) - keine Logikaenderung, nur Export.
    debtRatioAmpel,
    dynVerschuldungAmpel,
    fcfTrendAmpel,
    fundamentalSeries,
    priceMonthly: { stock: stockMonthly, index: indexMonthly },
    relativeStrength,
    returnBars,
    avgVolume,
    profile,
    peers: arr(d.peers),
    news: newsRaw.slice(0, 15),
    dcf: dcfData,
  };
}

// ---------- STABILITAETS-SCORE ----------
// Buendelt FMP's Piotroski-F-Score und Altman-Z-Score mit den bereits an
// anderer Stelle berechneten harten Kennzahlen (Schuldenquote, dyn.
// Verschuldungsgrad, FCF-Trend) zu einem separaten, NICHT in score_total
// einfliessenden Wert.
export function computeStabilityScore(
  scoresData: any,
  debtRatioAmpel: number | null,
  dynVerschuldungAmpel: number | null,
  fcfTrendAmpel: number | null,
): { score: number | null; detail: any } {
  const scoreRow = first(scoresData);
  if (!scoreRow) {
    return { score: null, detail: { hinweis: "FMP financial-scores nicht verfuegbar." } };
  }

  // Piotroski F-Score: 0 bis 9, hoeher besser
  const piotroski = typeof scoreRow.piotroskiScore === "number" ? scoreRow.piotroskiScore : null;
  const piotroskiAmpel = piotroski === null ? null : piotroski >= 7 ? 1 : piotroski >= 4 ? 0.5 : 0;

  // Altman Z-Score: > 2.99 sicher, 1.81-2.99 Grauzone, < 1.81 insolvenznah
  const altman = typeof scoreRow.altmanZScore === "number" ? scoreRow.altmanZScore : null;
  const altmanAmpel = altman === null ? null : altman > 2.99 ? 1 : altman >= 1.81 ? 0.5 : 0;

  const pflicht = [
    { a: piotroskiAmpel, w: 1 },
    { a: altmanAmpel, w: 1 },
    { a: debtRatioAmpel, w: 1 },
    { a: dynVerschuldungAmpel, w: 1 },
    { a: fcfTrendAmpel, w: 1 },
  ];
  const score = subScore(pflicht);

  return {
    score: score !== null ? Math.round(score) : null,
    detail: { piotroski, piotroskiAmpel, altman, altmanAmpel },
  };
}

// ---------- BEWERTUNGSKENNZAHLEN (Fair Value KGV/KCV+DCF / EV-Umsatz) ----------
// EV-Umsatz bleibt eine grobe, branchenunabhaengige Einordnung gegen absolute
// Schwellen (eigene Setzung, keine FMP- oder Analysten-Vorgabe) - die
// Legrand-Methodik (Abschnitt 8) deckt EV-Umsatz nicht ab, daher unveraendert.
function lastValid(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (typeof values[i] === "number") return values[i] as number;
  }
  return null;
}
function classifyValuation(value: number | null, guenstigUnter: number, teuerUeber: number) {
  if (value === null || !isFinite(value) || value <= 0) {
    return { value: null, label: "keine Bewertung möglich" };
  }
  if (value < guenstigUnter) return { value: Math.round(value * 10) / 10, label: "günstig" };
  if (value > teuerUeber) return { value: Math.round(value * 10) / 10, label: "eher teuer" };
  return { value: Math.round(value * 10) / 10, label: "fair" };
}

// Variationskoeffizient (Standardabweichung/Mittelwert) - derselbe
// Stetigkeits-Massstab wie in stabilityOrRisingAmpel() weiter oben, hier
// wiederverwendet, um KGV- vs. KCV-Weg gegeneinander zu gewichten.
function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return null;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

// Fair Value nach Legrand-Methodik Abschnitt 8: durchschnittliches
// historisches Multiple (KGV, KCV) mal aktuellem Gewinn/Cashflow je Aktie,
// dazu DCF als "zweites Standbein" (hier: 50/50-Gewichtung - die Methodik-
// Doc gibt kein exaktes Gewicht vor, "Standbein" liest sich als gleichrangig).
// Reprasentativer Zeitraum: dieselben Jahre wie fundamentalSeries (aktuell
// 5) - kein zusaetzlicher FMP-Abruf noetig, konsistent mit den uebrigen
// Fundamental-Tab-Charts. KCV nutzt operativen Cashflow (nicht FCF), passend
// zur Methodik-Doc-Definition (Abschnitt 9: "Kurs / operativer CF pro
// Aktie") - andere FCF-Verwendungen im Projekt (Cashflow-Chart etc.)
// bleiben unangetastet.
function computeFairValue(fundamentalSeries: any, stockMonthly: { date: string; close: number }[], currentPrice: number, dcfValue: number | null) {
  const monthClose = new Map(stockMonthly.map((m) => [m.date.slice(0, 7), m.close]));
  const n = fundamentalSeries.years.length;

  const kgvSeries: number[] = [];
  const kcvSeries: number[] = [];
  let latestEps: number | null = null;
  let latestOcfPerShare: number | null = null;

  for (let i = 0; i < n; i++) {
    const date = fundamentalSeries.datesFull?.[i];
    const price = date ? monthClose.get(String(date).slice(0, 7)) : undefined;
    const netIncome = fundamentalSeries.netIncome[i];
    const ocf = fundamentalSeries.operatingCashFlow[i];
    const shares = fundamentalSeries.sharesOut[i];

    const eps = typeof netIncome === "number" && typeof shares === "number" && shares !== 0 ? netIncome / shares : null;
    const ocfPerShare = typeof ocf === "number" && typeof shares === "number" && shares !== 0 ? ocf / shares : null;

    if (eps !== null && eps > 0) latestEps = eps; // spaeteste (letzte) gueltige Zeile gewinnt
    if (ocfPerShare !== null && ocfPerShare > 0) latestOcfPerShare = ocfPerShare;

    if (typeof price === "number" && eps !== null && eps > 0) kgvSeries.push(price / eps);
    if (typeof price === "number" && ocfPerShare !== null && ocfPerShare > 0) kcvSeries.push(price / ocfPerShare);
  }

  const avgKgv = kgvSeries.length ? kgvSeries.reduce((a, b) => a + b, 0) / kgvSeries.length : null;
  const avgKcv = kcvSeries.length ? kcvSeries.reduce((a, b) => a + b, 0) / kcvSeries.length : null;

  const fairValueKgvWeg = avgKgv !== null && latestEps !== null ? avgKgv * latestEps : null;
  const fairValueKcvWeg = avgKcv !== null && latestOcfPerShare !== null ? avgKcv * latestOcfPerShare : null;

  let multiplesFairValue: number | null = null;
  if (fairValueKgvWeg !== null && fairValueKcvWeg !== null) {
    const cvKgv = coefficientOfVariation(kgvSeries);
    const cvKcv = coefficientOfVariation(kcvSeries);
    if (cvKgv !== null && cvKcv !== null && cvKgv > 0 && cvKcv > 0) {
      // Inverse-CV-Gewichtung: die stetigere (ruhigere) Kennzahl bekommt
      // mehr Gewicht, aber keine wird komplett verworfen.
      const wKgv = (1 / cvKgv) / (1 / cvKgv + 1 / cvKcv);
      multiplesFairValue = wKgv * fairValueKgvWeg + (1 - wKgv) * fairValueKcvWeg;
    } else if (cvKgv === 0 && cvKcv !== 0) {
      multiplesFairValue = fairValueKgvWeg; // KGV perfekt stetig -> voll bevorzugt
    } else if (cvKcv === 0 && cvKgv !== 0) {
      multiplesFairValue = fairValueKcvWeg; // KCV perfekt stetig -> voll bevorzugt
    } else {
      multiplesFairValue = (fairValueKgvWeg + fairValueKcvWeg) / 2; // CV nicht bestimmbar (z.B. <2 Punkte) -> 50/50
    }
  } else {
    multiplesFairValue = fairValueKgvWeg ?? fairValueKcvWeg;
  }

  // DCF-Gewicht 30% statt gleichrangig 50%: die Methodik-Doc nennt DCF nur
  // als "Substanzanker" neben KGV/KCV, nicht als gleichrangigen Faktor -
  // bei 50% dominierte DCF sonst zu stark und erzeugte bei stabilen
  // Qualitaetswerten unplausible "stark ueberbewertet"-Ergebnisse.
  const fairValue = multiplesFairValue !== null && dcfValue !== null
    ? 0.7 * multiplesFairValue + 0.3 * dcfValue
    : multiplesFairValue ?? dcfValue;

  if (fairValue === null || !isFinite(fairValue) || fairValue <= 0) {
    return {
      value: null,
      label: "keine Bewertung möglich",
      abweichung_pct: null,
      kontext: { avg_kgv: avgKgv, avg_kcv: avgKcv, dcf: dcfValue, jahre: n },
    };
  }

  const abweichung = currentPrice / fairValue - 1;
  const label = Math.abs(abweichung) <= 0.05 ? "fair bewertet" : abweichung > 0 ? "eher teuer" : "günstig";

  return {
    value: Math.round(fairValue * 100) / 100,
    label,
    abweichung_pct: Math.round(abweichung * 1000) / 1000,
    kontext: {
      avg_kgv: avgKgv !== null ? Math.round(avgKgv * 100) / 100 : null,
      avg_kcv: avgKcv !== null ? Math.round(avgKcv * 100) / 100 : null,
      dcf: dcfValue !== null ? Math.round(dcfValue * 100) / 100 : null,
      jahre: n,
    },
  };
}

export function computeValuation(
  fundamentalSeries: any,
  stockMonthly: { date: string; close: number }[],
  currentPrice: number | null,
  dcfValue: number | null,
): any {
  const revenue = lastValid(fundamentalSeries.revenue);
  const sharesOut = lastValid(fundamentalSeries.sharesOut);
  const totalDebt = lastValid(fundamentalSeries.totalDebt);
  const cash = lastValid(fundamentalSeries.cash);

  if (!currentPrice || !sharesOut) {
    return { verfuegbar: false, hinweis: "Bewertungskennzahlen nicht berechenbar (Kurs oder Aktienzahl fehlen)." };
  }

  const marketCap = currentPrice * sharesOut;
  const netDebt = (totalDebt ?? 0) - (cash ?? 0);
  const ev = marketCap + netDebt;
  const evUmsatzRaw = revenue !== null && revenue !== 0 ? ev / revenue : null;

  return {
    verfuegbar: true,
    market_cap: Math.round(marketCap * 100) / 100,
    ev: Math.round(ev * 100) / 100,
    fair_value: computeFairValue(fundamentalSeries, stockMonthly, currentPrice, dcfValue),
    ev_umsatz: classifyValuation(evUmsatzRaw, 2, 6),
    hinweis: "EV-Umsatz-Einordnung ist eine grobe, branchenunabhaengige Standard-Setzung, keine Analysten-Bewertung. Fair Value basiert auf durchschnittlichem historischem KGV/KCV (5 Jahre, 70%) plus DCF als Substanzanker (30%), Toleranzband ±5% fuer \"fair bewertet\" (Legrand-Methodik Abschnitt 8).",
  };
}

// ---------- ANALYSTEN-KONSENS + BANK-EINSTUFUNGEN (fuer KI-Einschaetzung-Tab) ----------
// price-target-summary liefert einen aggregierten Konsenswert je Zeitraum -
// lastQuarter ist der beste Kompromiss aus Aktualitaet und Stichprobengroesse.
export function computeAnalystConsensus(priceTargetSummaryRaw: any): { target: number; count: number } | null {
  const row = first(priceTargetSummaryRaw);
  if (
    !row ||
    typeof row.lastQuarterAvgPriceTarget !== "number" ||
    typeof row.lastQuarterCount !== "number" ||
    row.lastQuarterCount === 0
  ) {
    return null;
  }
  return {
    target: Math.round(row.lastQuarterAvgPriceTarget * 100) / 100,
    count: row.lastQuarterCount,
  };
}

// grades liefert qualitative Einstufungen (kein Dollar-Kursziel) einzelner
// Banken, teils jahrelange Historie - hier auf die letzten 3 Monate gefiltert
// und pro Bank nur der neueste Eintrag, neueste zuerst.
export function computeBankRatings(
  gradesRaw: any,
): { company: string; grade: string; action: string; date: string; previousGrade: string }[] {
  const rows = arr(gradesRaw);
  const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const recent = rows.filter((r: any) => typeof r.date === "string" && +new Date(r.date) >= cutoffMs);

  const byCompany = new Map<string, any>();
  for (const r of recent) {
    const existing = byCompany.get(r.gradingCompany);
    if (!existing || +new Date(r.date) > +new Date(existing.date)) {
      byCompany.set(r.gradingCompany, r);
    }
  }

  return [...byCompany.values()]
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .map((r) => ({
      company: r.gradingCompany,
      grade: r.newGrade,
      action: r.action,
      date: r.date,
      previousGrade: r.previousGrade,
    }));
}

// ---------- PROGNOSE-SZENARIEN (Baer/Basis/Bull) ----------
const MULTIPLES = {
  baer: { kgv: 25, kcv: 22 },
  basis: { kgv: 40, kcv: 33 },
  bull: { kgv: 55, kcv: 44 },
};
const PROBABILITIES = { baer: 0.30, basis: 0.45, bull: 0.25 };

export function computePrognose(d: any, currentPrice: number | null, sharesOut: number | null) {
  const estimatesRaw = arr(d.estimates).slice().sort((a: any, b: any) => +new Date(a.date) - +new Date(b.date));
  const target = estimatesRaw.slice(-1)[0]; // am weitesten in der Zukunft liegende verfuegbare Schaetzung

  if (!target || !currentPrice || !sharesOut) {
    return { verfuegbar: false, hinweis: "Prognose nicht berechenbar (Analysten-Schaetzungen, Kurs oder Aktienzahl fehlen)." };
  }

  const targetYear = Number((target.date || "").slice(0, 4));
  const currentYear = new Date().getFullYear();
  const jahre = targetYear - currentYear;
  if (!jahre || jahre <= 0) {
    return { verfuegbar: false, hinweis: "Keine Analysten-Schaetzung fuer ein zukuenftiges Jahr verfuegbar." };
  }

  const epsAvg = target.epsAvg ?? null;
  const ebitdaAvg = target.ebitdaAvg ?? null;
  const cashflowPerShareApprox = typeof ebitdaAvg === "number" ? ebitdaAvg / sharesOut : null;

  function scenario(key: "baer" | "basis" | "bull") {
    const m = MULTIPLES[key];
    const zielKgv = typeof epsAvg === "number" ? epsAvg * m.kgv : null;
    const zielKcv = typeof cashflowPerShareApprox === "number" ? cashflowPerShareApprox * m.kcv : null;
    const ziel = zielKgv !== null && zielKcv !== null ? (zielKgv + zielKcv) / 2
      : zielKgv ?? zielKcv ?? null;
    if (ziel === null) return null;
    const jahresrendite = Math.pow(ziel / currentPrice, 1 / jahre) - 1;
    const gesamtrendite = ziel / currentPrice - 1;
    const fairValueHeute = ziel / Math.pow(1.10, jahre);
    return {
      ziel: Math.round(ziel * 100) / 100,
      jahresrendite: Math.round(jahresrendite * 1000) / 1000,
      gesamtrendite: Math.round(gesamtrendite * 1000) / 1000,
      fair_value_heute: Math.round(fairValueHeute * 100) / 100,
      wahrscheinlichkeit: PROBABILITIES[key],
    };
  }

  const baer = scenario("baer");
  const basis = scenario("basis");
  const bull = scenario("bull");

  let erwartungswert: number | null = null;
  if (baer && basis && bull) {
    erwartungswert = Math.round(
      (baer.ziel * PROBABILITIES.baer + basis.ziel * PROBABILITIES.basis + bull.ziel * PROBABILITIES.bull) * 100,
    ) / 100;
  }

  // Kurspfad (Erwartungskorridor): geometrische Fortschreibung von currentPrice
  // mit der je Szenario bereits berechneten jahresrendite - kein neuer Wert,
  // nur eine Jahr-fuer-Jahr-Auffaecherung der bestehenden Endziele.
  const pfad: { jahr: number; baer: number | null; basis: number | null; bull: number | null }[] = [];
  for (let i = 0; i <= jahre; i++) {
    pfad.push({
      jahr: currentYear + i,
      baer: baer ? Math.round(currentPrice * Math.pow(1 + baer.jahresrendite, i) * 100) / 100 : null,
      basis: basis ? Math.round(currentPrice * Math.pow(1 + basis.jahresrendite, i) * 100) / 100 : null,
      bull: bull ? Math.round(currentPrice * Math.pow(1 + bull.jahresrendite, i) * 100) / 100 : null,
    });
  }

  return {
    verfuegbar: true,
    zieljahr: targetYear,
    jahre_bis_zieljahr: jahre,
    aktueller_kurs: currentPrice,
    baer, basis, bull,
    erwartungswert,
    pfad,
    hinweis: "Wahrscheinlichkeiten (30/45/25) sind eine begruendete Standard-Setzung, keine Formel. Cashflow-Weg ueber EBITDA genaehert, da operativer Cashflow in Analysten-Schaetzungen fehlt. Keine harte Kurszusage.",
  };
}
