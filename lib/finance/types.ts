export interface YearData {
  year: number; // fiscal year, e.g. 2025
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null; // operatingIncome + depreciation (approximation)
  operatingCashFlow: number | null;
  capex: number | null; // POSITIVE spend
  freeCashFlow: number | null; // operatingCashFlow - capex
  totalDebt: number | null;
  cash: number | null;
  equity: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  interestExpense: number | null; // positive
  sharesOutstanding: number | null;
  yearEndPrice: number | null; // close nearest fiscal year end
}

export interface FinancialSnapshot {
  ticker: string;
  name: string;
  currency: string;
  price: number;
  marketCap: number | null;
  sharesOutstanding: number;
  beta: number | null;
  sector: string | null; // Yahoo assetProfile sector, e.g. "Technology"; null = unknown
  industry: string | null; // Yahoo assetProfile industry, e.g. "Internet Content & Information"; null = unknown
  trailingEPS: number | null;
  riskFreeRate: number; // decimal e.g. 0.042
  years: YearData[]; // NEWEST FIRST, up to ~4 entries
  // Trailing-twelve-month bases (Yahoo financialData) — the reference site's
  // DCF family runs on TTM, not last fiscal year. Null → fall back to years[0].
  ttm: {
    operatingCashFlow: number | null;
    freeCashFlow: number | null;
    netIncome: number | null;
  } | null;
  growthHistory: { year: number; revenue: number | null; netIncome: number | null }[] | null; // newest-first, from SEC EDGAR, up to 8y — growth seeding only
  nextEarningsDate: string | null; // ISO date from Yahoo quoteSummary "calendarEvents" module; null when unavailable
  // True for a foreign ADR whose statement currency (financialCurrency) differs
  // from its price currency AND no FX cross-rate was available to reconcile them,
  // so money fields remain in the home currency. UI can warn; default false.
  currencyMismatch: boolean;
  fetchedAt: string; // ISO
}

// Which valuation methodology computeValuation runs. "calibrated" (default)
// is fitted to the reference site's live calculator (caps, TTM bases, sector
// multiples, no terminal value). "textbook" is the app's original
// pre-calibration approach: uncapped CAPM/growth, a linear growth fade PLUS a
// Gordon terminal value, audited fiscal-year bases, and own-history-only
// multiples. All 10 models exist in both; only the underlying math differs.
export type ValuationVariant = "calibrated" | "textbook";

// Valuation horizon: "current" (today, the existing behavior), "nextYear"
// (every model re-answers "what will one share be worth ONE fiscal year from
// now if our assumptions hold?" by advancing its own cash flow/metric one
// year along its own growth path — see valuation.ts's `advance` and
// `growthPath`), or the quarterly points "q1"/"q2" (3-mo/6-mo forward)
// — geometric-interpolation points on the current->nextYear path, not
// independently re-run models. See valuation.ts's `interpolateGeometric`.
export type Horizon = "current" | "q1" | "q2" | "nextYear";

export interface Assumptions {
  normalGrowth: number; // decimal, e.g. 0.12
  terminalGrowth: number; // decimal, default 0.03
  marginExpansion: number; // pp/year as decimal, e.g. 0.005 = +0.5pp/yr, default 0
  wacc: number; // decimal
  hHalfLife: number; // years, default 4
}

export interface ModelResult {
  key: string;
  name: string; // e.g. "DCF-20"
  variant: string; // e.g. "20Y · Operating CF"
  value: number | null; // implied price per share
  note?: string; // reason when value is null
}

export interface ValuationOutput {
  models: ModelResult[];
  composite: number | null; // trimmed mean
  range: { min: number; max: number } | null;
  assumptions: Assumptions; // resolved (autos filled in)
  autoNormalGrowth: number;
  autoWacc: number;
}

export type Grade = "A" | "B+" | "B" | "C+" | "C" | "D" | "F";

export interface DimensionScore {
  key: string;
  name: string;
  score: number | null; // 0-100
  grade: Grade | null;
  detail: string; // e.g. "ROIC 18%, net margin 24%"
}

export interface QualityOutput {
  dimensions: DimensionScore[];
  overallScore: number | null;
  overallGrade: Grade | null;
}
