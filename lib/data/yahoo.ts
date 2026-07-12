import YahooFinance from "yahoo-finance2";
import { FinancialSnapshot, YearData } from "@/lib/finance/types";
import { fetchGrowthHistory } from "./edgar";

// yahoo-finance2 v3 exports a class (not a singleton). Instantiate once and
// reuse. suppressNotices silences the one-time survey banner.
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export interface RawBundle {
  qs: any;
  chartQuotes: { date: string; close: number | null }[];
  riskFree: number;
}

const num = (v: any): number | null => {
  // yahoo-finance2 returns numbers or {raw: n} depending on version/module
  const n = typeof v === "object" && v !== null ? v.raw : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const abs = (v: number | null): number | null => (v === null ? null : Math.abs(v));

// Best-effort date extraction for yahoo-finance2's calendarEvents module,
// whose earnings-date fields arrive as a Date instance, a unix-epoch number
// (seconds, occasionally ms), a {raw:n} wrapper, or a plain date string
// depending on library version. Never throws — returns null on anything odd.
function dateOf(v: any): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000; // seconds vs ms epoch heuristic
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof v === "object" && typeof v.raw === "number") return dateOf(v.raw);
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}

function closeNearest(quotes: RawBundle["chartQuotes"], target: Date): number | null {
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const q of quotes) {
    if (q.close === null) continue;
    const diff = Math.abs(new Date(q.date).getTime() - target.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = q.close;
    }
  }
  // only accept a close within ~60 days of the fiscal year end
  return bestDiff <= 60 * 86400_000 ? best : null;
}

export function normalizeSnapshot(raw: RawBundle, ticker: string): FinancialSnapshot {
  const { qs } = raw;
  const income: any[] = qs.incomeStatementHistory?.incomeStatementHistory ?? [];
  const balance: any[] = qs.balanceSheetHistory?.balanceSheetStatements ?? [];
  const cashflow: any[] = qs.cashflowStatementHistory?.cashflowStatements ?? [];

  const byYear = (rows: any[]) => {
    const m = new Map<number, any>();
    for (const r of rows) {
      const d = r.endDate ? new Date(r.endDate) : null;
      if (d) m.set(d.getUTCFullYear(), { ...r, _end: d });
    }
    return m;
  };
  const incomeBy = byYear(income);
  const balanceBy = byYear(balance);
  const cashBy = byYear(cashflow);

  const years: YearData[] = [...incomeBy.keys()]
    .sort((a, b) => b - a) // newest first
    .map((year) => {
      const inc = incomeBy.get(year) ?? {};
      const bal = balanceBy.get(year) ?? {};
      const cf = cashBy.get(year) ?? {};
      const opInc = num(inc.operatingIncome);
      const dep = num(cf.depreciation);
      const ocf = num(cf.totalCashFromOperatingActivities);
      const capex = abs(num(cf.capitalExpenditures));
      const debt = (num(bal.shortLongTermDebt) ?? 0) + (num(bal.longTermDebt) ?? 0);
      const cash = (num(bal.cash) ?? 0) + (num(bal.shortTermInvestments) ?? 0);
      return {
        year,
        revenue: num(inc.totalRevenue),
        grossProfit: num(inc.grossProfit),
        operatingIncome: opInc,
        netIncome: num(inc.netIncome),
        ebitda: opInc !== null && dep !== null ? opInc + dep : opInc,
        operatingCashFlow: ocf,
        capex,
        freeCashFlow: ocf !== null && capex !== null ? ocf - capex : null,
        totalDebt: num(bal.shortLongTermDebt) !== null || num(bal.longTermDebt) !== null ? debt : null,
        cash: num(bal.cash) !== null || num(bal.shortTermInvestments) !== null ? cash : null,
        equity: num(bal.totalStockholderEquity),
        currentAssets: num(bal.totalCurrentAssets),
        currentLiabilities: num(bal.totalCurrentLiabilities),
        interestExpense: abs(num(inc.interestExpense)),
        sharesOutstanding: num(qs.defaultKeyStatistics?.sharesOutstanding),
        yearEndPrice: closeNearest(raw.chartQuotes, inc._end ?? new Date(`${year}-12-31`)),
      };
    });

  // Latest year: prefer financialData current debt/cash (more complete)
  if (years[0]) {
    const fdDebt = num(qs.financialData?.totalDebt);
    const fdCash = num(qs.financialData?.totalCash);
    if (fdDebt !== null) years[0].totalDebt = fdDebt;
    if (fdCash !== null) years[0].cash = fdCash;
  }

  const price = num(qs.price?.regularMarketPrice);
  // Reason: sharesOutstanding is the LISTED class only — for dual-class names
  // (GOOGL ~5.9B of 12.2B) per-share math doubles. Prefer implied total shares
  // (all classes): impliedSharesOutstanding, else marketCap/price.
  const shares =
    num(qs.defaultKeyStatistics?.impliedSharesOutstanding) ??
    (num(qs.price?.marketCap) !== null && price !== null && price > 0
      ? num(qs.price?.marketCap)! / price
      : null) ??
    num(qs.defaultKeyStatistics?.sharesOutstanding);
  if (price === null || shares === null || shares <= 0) {
    throw new Error("TICKER_NOT_FOUND");
  }

  return {
    ticker: ticker.toUpperCase(),
    name: qs.price?.longName ?? qs.price?.shortName ?? ticker.toUpperCase(),
    currency: qs.price?.currency ?? "USD",
    price,
    marketCap: num(qs.price?.marketCap),
    sharesOutstanding: shares,
    beta: num(qs.defaultKeyStatistics?.beta),
    sector: typeof qs.assetProfile?.sector === "string" ? qs.assetProfile.sector : null,
    industry: typeof qs.assetProfile?.industry === "string" ? qs.assetProfile.industry : null,
    // TTM bases (reference site's DCF family runs on TTM, not last FY).
    ttm: {
      operatingCashFlow: num(qs.financialData?.operatingCashflow),
      freeCashFlow: num(qs.financialData?.freeCashflow),
      netIncome:
        num(qs.defaultKeyStatistics?.trailingEps) !== null
          ? num(qs.defaultKeyStatistics?.trailingEps)! * shares
          : null,
    },
    trailingEPS: num(qs.defaultKeyStatistics?.trailingEps),
    riskFreeRate: raw.riskFree,
    years,
    // Defaulted to null here so the pure normalizer stays offline-testable;
    // fetchSnapshot fills it from SEC EDGAR (network) after building.
    growthHistory: null,
    // Default null here so the pure normalizer stays offline-testable;
    // fetchSnapshot fills it from the calendarEvents module (network) after
    // building, and never fails the snapshot on a missing/odd payload.
    nextEarningsDate: null,
    // Default false; fetchSnapshot flips it true only for a foreign ADR whose
    // statement currency differs from its price currency with no FX rate found.
    currencyMismatch: false,
    fetchedAt: new Date().toISOString(),
  };
}

// Convert every MONEY field of a snapshot from its statement (home) currency to
// the price/trading currency by multiplying by `rate` (home→price, e.g. TWD→USD
// ≈ 0.031). Returns a NEW snapshot; pure and offline-testable.
// NOT scaled: sharesOutstanding (a share count) and yearEndPrice (already the
// ADR price in the trading currency). Keeping yearEndPrice in the trading
// currency while scaling revenue/etc. into the same currency means
// yearEndPrice × sharesOutstanding (the historical market cap) stays consistent
// with the converted metrics, so medianMultiple ratios remain correct.
// ALSO NOT scaled: ttm.netIncome — unlike ttm.operatingCashFlow / ttm.freeCashFlow
// (both from financialData, reported in the home currency), ttm.netIncome is
// derived in normalizeSnapshot as trailingEPS × shares, and the ADR's trailingEPS
// is already the trading-currency EPS. Scaling it would double-convert (e.g. TSM
// $59.6B → a nonsensical $1.85B, collapsing DNI-20 to ~$8/share). Same rationale
// as yearEndPrice: a figure already in the trading currency is left as-is.
// growthHistory is intentionally left untouched: SEC EDGAR is USD for US filers,
// and foreign ADRs carry null growthHistory whose units aren't known to be home
// currency — so we never scale it here.
export function convertSnapshotCurrency(s: FinancialSnapshot, rate: number): FinancialSnapshot {
  const m = (v: number | null): number | null => (v === null ? null : v * rate);
  const years: YearData[] = s.years.map((y) => ({
    ...y,
    revenue: m(y.revenue),
    grossProfit: m(y.grossProfit),
    operatingIncome: m(y.operatingIncome),
    netIncome: m(y.netIncome),
    ebitda: m(y.ebitda),
    operatingCashFlow: m(y.operatingCashFlow),
    capex: m(y.capex),
    freeCashFlow: m(y.freeCashFlow),
    totalDebt: m(y.totalDebt),
    cash: m(y.cash),
    equity: m(y.equity),
    currentAssets: m(y.currentAssets),
    currentLiabilities: m(y.currentLiabilities),
    interestExpense: m(y.interestExpense),
    // sharesOutstanding + yearEndPrice deliberately unscaled (see fn doc).
  }));
  const ttm = s.ttm
    ? {
        operatingCashFlow: m(s.ttm.operatingCashFlow), // financialData → home ccy
        freeCashFlow: m(s.ttm.freeCashFlow), // financialData → home ccy
        netIncome: s.ttm.netIncome, // trailingEPS-derived → already trading ccy
      }
    : s.ttm;
  return { ...s, years, ttm };
}

// --- API-drift adapter (yahoo-finance2 v3, Nov-2024 backend change) -----------
// The classic quoteSummary statement submodules (incomeStatementHistory,
// balanceSheetHistory, cashflowStatementHistory) have returned near-empty data
// since Nov 2024 (balance sheet only endDate; cash flow only netIncome). The
// library now directs callers to `fundamentalsTimeSeries`, which still carries
// full annual financials. We fetch that and reshape its flat, richly-named rows
// into the exact RawBundle.qs statement shape that normalizeSnapshot consumes,
// so the pure normalizer + its fixed tests stay unchanged.
function ftsToStatements(rows: any[]) {
  // Keep only rows with a real revenue figure (drops the sparse trailing-edge
  // year the time-series window sometimes includes).
  const good = (rows ?? []).filter((r) => num(r.totalRevenue) !== null);
  const income = good.map((r) => ({
    endDate: r.date,
    totalRevenue: r.totalRevenue,
    grossProfit: r.grossProfit,
    operatingIncome: r.operatingIncome ?? r.totalOperatingIncomeAsReported,
    netIncome: r.netIncome,
    interestExpense: r.interestExpense, // often absent on the newest FY
  }));
  const balance = good.map((r) => ({
    endDate: r.date,
    totalCurrentAssets: r.currentAssets,
    totalCurrentLiabilities: r.currentLiabilities,
    totalStockholderEquity: r.stockholdersEquity ?? r.commonStockEquity,
    shortLongTermDebt: r.currentDebt ?? r.currentDebtAndCapitalLeaseObligation,
    longTermDebt: r.longTermDebt ?? r.longTermDebtAndCapitalLeaseObligation,
    cash: r.cashAndCashEquivalents,
    shortTermInvestments: r.otherShortTermInvestments,
  }));
  const cashflow = good.map((r) => ({
    endDate: r.date,
    totalCashFromOperatingActivities: r.operatingCashFlow ?? r.cashFlowFromContinuingOperatingActivities,
    capitalExpenditures: r.capitalExpenditure, // negative; normalizeSnapshot abs()es
    depreciation: r.depreciationAndAmortization ?? r.depreciationAmortizationDepletion,
  }));
  return {
    incomeStatementHistory: { incomeStatementHistory: income },
    balanceSheetHistory: { balanceSheetStatements: balance },
    cashflowStatementHistory: { cashflowStatements: cashflow },
  };
}

export interface SearchResult {
  symbol: string;
  shortname: string;
  exchDisp: string;
  typeDisp: string;
}

// Global header search bar's suggestion source. Only EQUITY/ETF quotes that
// Yahoo itself recognizes (isYahooFinance) make sense as a `/stock/{ticker}`
// destination — indices, options, crypto, etc. are filtered out. Never
// throws: the route wraps this in a try/catch too, but a bad/odd payload here
// should just mean "no suggestions" rather than a 500 for header search.
export async function searchTickers(q: string): Promise<SearchResult[]> {
  let result: any;
  try {
    result = await yf.search(q, {}, { validateResult: false });
  } catch {
    return [];
  }
  const quotes: any[] = Array.isArray(result?.quotes) ? result.quotes : [];
  return quotes
    .filter(
      (r) =>
        r?.isYahooFinance === true &&
        (r?.quoteType === "EQUITY" || r?.quoteType === "ETF") &&
        typeof r?.symbol === "string"
    )
    .slice(0, 8)
    .map((r) => ({
      symbol: r.symbol,
      shortname: typeof r.shortname === "string" ? r.shortname : r.symbol,
      exchDisp: typeof r.exchDisp === "string" ? r.exchDisp : "",
      typeDisp: typeof r.typeDisp === "string" ? r.typeDisp : "",
    }));
}

export interface SimilarTicker {
  ticker: string;
  name: string;
}

// Free "similar stocks" source for the competitors feature (see
// app/api/competitors/[ticker]/route.ts) — Gemini is now only a fallback when
// this throws or returns empty. recommendationsBySymbol gives algorithmic
// similarity (sector/price-movement/market-cap based) rather than an LLM's
// judgment, so results can differ from what Gemini used to return, but need
// no API key and are effectively free/instant.
export async function similarTickers(ticker: string): Promise<SimilarTicker[]> {
  const T = ticker.toUpperCase();
  let rec: any;
  try {
    // v3 validates against a schema and throws on shape drift; disable like
    // the other calls in this file so a partial/renamed payload degrades
    // gracefully instead of throwing.
    rec = await yf.recommendationsBySymbol(T, {}, { validateResult: false });
  } catch {
    return [];
  }
  const symbols = Array.isArray(rec?.recommendedSymbols)
    ? [
        ...new Set(
          rec.recommendedSymbols
            .filter((r: any) => typeof r?.symbol === "string")
            .map((r: any) => r.symbol.toUpperCase())
        ),
      ].filter((s): s is string => s !== T)
    : [];
  if (!symbols.length) return [];
  const top5 = symbols.slice(0, 5);

  // Batched quote() call for display names (one request for all 5) — cheap.
  // Best-effort only: a missing/failed quote just falls back to the ticker
  // string as its own name rather than dropping the candidate.
  const quoteBySymbol = new Map<string, any>();
  try {
    const q: any = await yf.quote(top5, {}, { validateResult: false });
    for (const item of Array.isArray(q) ? q : [q]) {
      if (typeof item?.symbol === "string") quoteBySymbol.set(item.symbol.toUpperCase(), item);
    }
  } catch {
    /* names fall back to ticker strings below */
  }

  return top5
    .filter((sym) => {
      const q = quoteBySymbol.get(sym);
      // Drop only when we KNOW it's non-equity junk (indices, futures, FX,
      // crypto, etc.) — an unknown/missing quoteType (quote() failed for
      // this symbol) is kept rather than dropped.
      return !q?.quoteType || q.quoteType === "EQUITY" || q.quoteType === "ETF";
    })
    .map((sym) => {
      const q = quoteBySymbol.get(sym);
      const name =
        typeof q?.longName === "string" ? q.longName : typeof q?.shortName === "string" ? q.shortName : sym;
      return { ticker: sym, name };
    });
}

export async function fetchSnapshot(ticker: string): Promise<FinancialSnapshot> {
  let qs: any;
  try {
    // price/stats/financialData still populate correctly post-drift.
    qs = await yf.quoteSummary(
      ticker,
      {
        modules: [
          "price",
          "summaryDetail",
          "defaultKeyStatistics",
          "financialData",
          "assetProfile",
          "calendarEvents",
        ],
      },
      // v3 validates results against a schema and throws on shape drift;
      // disable so partial/renamed payloads flow through to normalizeSnapshot.
      { validateResult: false }
    );
  } catch {
    throw new Error("TICKER_NOT_FOUND");
  }

  // Annual financial statements via fundamentalsTimeSeries (post-Nov-2024 source).
  try {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 6);
    const fts: any = await yf.fundamentalsTimeSeries(
      ticker,
      { period1, period2: new Date(), type: "annual", module: "all" },
      { validateResult: false }
    );
    Object.assign(qs, ftsToStatements(Array.isArray(fts) ? fts : []));
  } catch {
    // Leave statements empty → years:[]; caller/normalizer still returns a
    // snapshot (price + stats) and downstream models degrade to n/a.
    Object.assign(qs, ftsToStatements([]));
  }

  // 5y monthly closes for historical multiples
  let chartQuotes: RawBundle["chartQuotes"] = [];
  try {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 6);
    const chart: any = await yf.chart(
      ticker,
      { period1, interval: "1mo" },
      { validateResult: false }
    );
    chartQuotes = (chart.quotes ?? []).map((q: any) => ({
      date: new Date(q.date).toISOString(),
      close: typeof q.close === "number" ? q.close : null,
    }));
  } catch {
    /* multiples models will show n/a */
  }

  // 10-yr treasury via ^TNX; yahoo reports the yield directly (e.g. 4.4)
  let riskFree = 0.042;
  try {
    const tnx: any = await yf.quote("^TNX");
    const v = tnx?.regularMarketPrice;
    if (typeof v === "number" && v > 0) riskFree = v > 1 ? v / 100 : v;
  } catch {
    /* keep default */
  }

  const snapshot = normalizeSnapshot({ qs, chartQuotes, riskFree }, ticker);

  // Next earnings date (calendarEvents module) — used by The Story tab's
  // "NEXT CATALYST" strip. Best-effort only; never fails the snapshot.
  try {
    const raw = qs.calendarEvents?.earnings?.earningsDate;
    const first = Array.isArray(raw) ? raw[0] : raw;
    snapshot.nextEarningsDate = dateOf(first);
  } catch {
    snapshot.nextEarningsDate = null;
  }

  // SEC EDGAR longer growth-history window (8+ annual years, free). Used only
  // to improve the growth seed; failure must NEVER fail the snapshot.
  try {
    snapshot.growthHistory = await fetchGrowthHistory(ticker);
  } catch {
    snapshot.growthHistory = null;
  }

  // Foreign-ADR currency reconciliation. Yahoo reports statement figures in the
  // company's home/reporting currency (financialData.financialCurrency, e.g. TWD
  // for TSM) while price & marketCap are the ADR trading currency (e.g. USD).
  // Left unconverted, per-share DCF prints home-currency-sized numbers
  // (TSM ~$11,255 vs the reference's USD-converted ~$462).
  const finCcy =
    typeof qs.financialData?.financialCurrency === "string" ? qs.financialData.financialCurrency : null;
  const priceCcy = typeof qs.price?.currency === "string" ? qs.price.currency : null;
  if (finCcy && priceCcy && finCcy !== priceCcy) {
    let rate: number | null = null;
    try {
      // e.g. "TWDUSD=X" → ~0.031 (home→price). Never guess a rate on failure.
      const fx: any = await yf.quote(`${finCcy}${priceCcy}=X`);
      const v = fx?.regularMarketPrice;
      if (typeof v === "number" && v > 0) rate = v;
    } catch {
      /* no rate available → degrade below */
    }
    if (rate !== null) {
      // Object.assign keeps the same reference; growthHistory (already set) is
      // preserved by the ...s spread inside convertSnapshotCurrency.
      Object.assign(snapshot, convertSnapshotCurrency(snapshot, rate));
    } else {
      // Couldn't fetch a rate: leave values home-currency but flag for the UI.
      snapshot.currencyMismatch = true;
    }
  }

  return snapshot;
}
