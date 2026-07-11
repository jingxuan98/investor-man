import { FinancialSnapshot, Assumptions, ValuationVariant } from "./types";
import { cagr, clamp, seriesOldestFirst } from "./helpers";

// ---------------------------------------------------------------------------
// Calibrated Jul 2026 against the reference site's LIVE calculator, whose
// per-stock inputs it exposes. Verified exact (ratio 1.000) on 12 tickers
// across all 11 sectors: WDAY GOOGL NVDA XOM JPM JNJ KO HD CAT NEE LIN PLD.
// Architecture: growth seed = own 5Y REVENUE CAGR (latest 5 fiscal endpoints,
// 4 transitions) capped at 30%; discount = CAPM with 5.5% ERP clamped [6%, 20%];
// three-stage 20y projection (see valuation.ts). PEG uses 5Y net-income CAGR
// instead (see pegGrowth).
// ---------------------------------------------------------------------------

// CAGR of a metric over a newest-first row window; null if <2 usable points.
function cagrOf<T>(rows: T[], pick: (r: T) => number | null): number | null {
  const xs = seriesOldestFirst(rows, pick);
  if (xs.length < 2) return null;
  return cagr(xs[xs.length - 1], xs[0], xs.length - 1);
}

// Min-span guard: only trust an EDGAR window when the metric has ≥4 non-null
// points in it — a sparse merged series must never masquerade as a long trend.
function edgarWindow(
  s: FinancialSnapshot,
  pick: (r: { year: number; revenue: number | null; netIncome: number | null }) => number | null
): FinancialSnapshot["growthHistory"] {
  const gh = s.growthHistory;
  if (gh === null || gh.length < 5) return null;
  // Reason: 6 endpoints (≈5-year span) — verified against the reference
  // CALCULATOR's actual input values (META g1_5=18.51 = FY2020→FY2025), NOT its
  // page-text "auto" label (14.3%), which comes from a different display-layer
  // formula the calculator itself does not use.
  const win = gh.slice(0, 6);
  const nonNull = win.filter((r) => {
    const v = pick(r);
    return v !== null && Number.isFinite(v);
  });
  return nonNull.length >= 4 ? win : null;
}

// 5Y revenue CAGR, uncapped. Prefers SEC EDGAR history (Yahoo caps at ~4y);
// falls back to Yahoo statement years. Window = up to 6 endpoints / 5
// transitions, matching the reference calculator's ACTUAL seed inputs
// (META 18.51, TSLA 24.63 — read from its DOM inputs, not its text labels).
export function revenueCagr5y(s: FinancialSnapshot): number | null {
  const win = edgarWindow(s, (r) => r.revenue);
  return cagrOf(win ?? s.years, (y: any) => y.revenue);
}

// 5Y net-income CAGR, uncapped — the reference site's PEG growth input
// (back-solved: GOOGL 24.8 vs actual 25.2, NVDA ≈99, KO 9.7 vs 10.0).
// Falls back to revenue CAGR when NI CAGR is incomputable (losses).
export function pegGrowth(s: FinancialSnapshot): number | null {
  const win = edgarWindow(s, (r) => r.netIncome);
  const ni = cagrOf(win ?? s.years, (y: any) => y.netIncome);
  return ni ?? revenueCagr5y(s);
}

// Auto growth seed: own 5Y revenue CAGR clamped [2%, 30%] — exactly the
// reference calculator's "Growth (Year 1–5): from own 5Y revenue CAGR,
// capped at 30%" with its 2% floor (VZ page: "5Y revenue CAGR 1.5%
// (floored at 2%)"). Default 5% when no history at all.
// "textbook" variant: the app's original pre-calibration behavior — the raw
// 5Y revenue CAGR, uncapped AND unfloored (still 5% default with no history).
export function autoNormalGrowth(
  s: FinancialSnapshot,
  variant: ValuationVariant = "calibrated"
): number {
  const g = revenueCagr5y(s);
  if (g === null) return 0.05;
  return variant === "textbook" ? g : clamp(g, 0.02, 0.3);
}

// Auto discount rate: CAPM with a 5.5% equity risk premium, capped at 12%.
// Fitted on the reference CALCULATOR's per-stock discount INPUTS (DOM values):
// rf 4.5 + β·5.5 reproduces WDAY 10.57 / GOOGL 11.36 / XOM 5.39 / JPM 9.90 /
// JNJ 5.79 / KO 6.42 to the basis point; NVDA (CAPM 16.7), CAT (13.1), TSLA,
// ASX and DDOG all show exactly 12.00 as the calculator input — the cap is
// real. (The 13-19% figures elsewhere on its pages are the Quality Gate's
// CAPM *estimate* display, which the calculator does not use.) Floor 4%.
// "textbook" variant: pure CAPM, no cap at all — a high-beta name can price
// out at a punishing discount rate. Only a 0.1% sanity floor so a
// near-zero/negative CAPM can't blow up a later division by wacc.
export function autoWacc(
  s: FinancialSnapshot,
  variant: ValuationVariant = "calibrated"
): number {
  const beta = s.beta ?? 1;
  const raw = s.riskFreeRate + beta * 0.055;
  return variant === "textbook" ? Math.max(raw, 0.001) : clamp(raw, 0.04, 0.12);
}

// Investor-style auto-classification, purely off the same 5Y revenue CAGR
// used to seed growth (see revenueCagr5y above) — a fast-growing top line is
// the single clearest signal of which valuation methods will price a stock
// sensibly. No history (null) is treated as mature: a steady/no-growth prior
// is the safer default absent evidence of growth.
export function classifyStock(s: FinancialSnapshot): "growth" | "balanced" | "mature" {
  const g = revenueCagr5y(s);
  if (g === null) return "mature";
  if (g >= 0.15) return "growth";
  if (g >= 0.07) return "balanced";
  return "mature";
}

export function resolveAssumptions(
  s: FinancialSnapshot,
  overrides: Partial<Assumptions> = {},
  variant: ValuationVariant = "calibrated"
): Assumptions {
  return {
    normalGrowth: overrides.normalGrowth ?? autoNormalGrowth(s, variant),
    // Terminal knob drives the H-model fade target AND stage 3 (years 11–20)
    // of the three-stage projection (calibrated), or the linear-fade endpoint
    // plus Gordon terminal value (textbook). Reference default is 4%
    // ("terminal-like"); textbook's classic-DCF default is a more
    // conventional 2.5% since it also carries a perpetuity beyond year 20.
    terminalGrowth: overrides.terminalGrowth ?? (variant === "textbook" ? 0.025 : 0.04),
    marginExpansion: overrides.marginExpansion ?? 0,
    wacc: overrides.wacc ?? autoWacc(s, variant),
    hHalfLife: overrides.hHalfLife ?? 4,
  };
}
