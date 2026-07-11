import { FinancialSnapshot, YearData } from "./types";
import { autoWacc } from "./assumptions";
import { threeStagePv, medianMultiple, resolveMultiples } from "./valuation";
import { clamp } from "./helpers";

export interface ReverseDcf {
  impliedGrowth: number | null;
  note?: string;
}

export interface EpvOutput {
  epvPerShare: number | null;
  growthPremiumPct: number | null;
  note?: string;
}

export interface OwnerYieldOutput {
  ownerEarnings: number | null;
  yieldPct: number | null;
  spreadVsTreasuryPp: number | null;
  note?: string;
}

export interface MultipleRow {
  key: string;
  name: string;
  current: number | null;
  ownHistoryMedian: number | null;
  ownImpliedPrice: number | null;
  sectorMedian: number | null;
  sectorImpliedPrice: number | null;
  premiumToSectorPct: number | null;
}

function latest(s: FinancialSnapshot): YearData | undefined {
  return s.years[0];
}

// ---------------------------------------------------------------------------
// General three-stage PV — same shape as valuation.ts's threeStagePv (years
// 1-5 @ g1, 6-10 @ g2, 11-20 @ g3, discounted at r, no terminal value beyond
// year 20) but with all three stage growth rates independent. threeStagePv
// hard-codes g6-10 = 0.7*g and g11-20 = the terminal knob, which is correct
// for the auto-filled Long-Horizon DCF card but breaks the moment a user
// edits Growth Y6-10 independently — this is the general form the UI needs.
// Equals threeStagePv(base, g1, wacc, terminalGrowth) when g2 = 0.7*g1 and
// g3 = terminalGrowth (see the parity test in insights.test.ts).
// ---------------------------------------------------------------------------
export function generalThreeStagePv(
  base: number,
  g1: number,
  g2: number,
  g3: number,
  r: number
): number | null {
  if (r <= 0) return null;
  let cf = base;
  let pv = 0;
  for (let i = 0; i < 20; i++) {
    const g = i < 5 ? g1 : i < 10 ? g2 : g3;
    cf *= 1 + g;
    pv += cf / Math.pow(1 + r, i + 1);
  }
  return pv;
}

// ---------------------------------------------------------------------------
// Reverse DCF — solve the growth seed g such that the EXISTING 3-stage DCF
// (dcf20's projection, exported as threeStagePv) plus net-debt adjustment
// equals the market cap. Bisection: g in [-0.5, 2.0], 60 iterations,
// tolerance 1e-6 on the equity/marketCap ratio.
// ---------------------------------------------------------------------------
export function reverseDcf(s: FinancialSnapshot): ReverseDcf {
  const y = latest(s);
  if (!y) return { impliedGrowth: null, note: "n/a — no financial statements available" };

  const base = s.ttm?.operatingCashFlow ?? y.operatingCashFlow;
  if (base === null || base <= 0)
    return { impliedGrowth: null, note: "n/a — missing/negative operating cash flow" };
  if (s.marketCap === null) return { impliedGrowth: null, note: "n/a — missing market cap" };

  const wacc = autoWacc(s);
  const netDebtAdj = (y.cash ?? 0) - (y.totalDebt ?? 0);
  const target = s.marketCap;

  const equityAt = (g: number): number | null => {
    const pv = threeStagePv(base, g, wacc);
    return pv === null ? null : pv + netDebtAdj;
  };

  let lo = -0.5;
  let hi = 2.0;
  let eqLo = equityAt(lo);
  let eqHi = equityAt(hi);
  if (eqLo === null || eqHi === null)
    return { impliedGrowth: null, note: "n/a — cannot solve (WACC must be positive)" };

  // Not bracketed: the market cap implies a growth rate outside [-50%, 200%].
  // Clamp to the nearest boundary rather than failing outright.
  if (target <= eqLo) return { impliedGrowth: lo, note: "clamped — implied growth below -50%" };
  if (target >= eqHi) return { impliedGrowth: hi, note: "clamped — implied growth above 200%" };

  let fLo = eqLo - target;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const eqMid = equityAt(mid);
    if (eqMid === null) return { impliedGrowth: null, note: "n/a — cannot solve (WACC must be positive)" };
    const fMid = eqMid - target;
    if (Math.abs(fMid) / Math.abs(target) < 1e-6) return { impliedGrowth: mid };
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
    }
  }
  return { impliedGrowth: (lo + hi) / 2 };
}

// ---------------------------------------------------------------------------
// EPV (zero-growth Earnings Power Value): 3Y average EBIT (operatingIncome) ×
// (1 - effective tax rate), capitalized at autoWacc, plus net cash, per share.
// ---------------------------------------------------------------------------
export function epv(s: FinancialSnapshot): EpvOutput {
  if (s.years.length === 0)
    return { epvPerShare: null, growthPremiumPct: null, note: "n/a — no financial statements available" };

  const window = s.years.slice(0, 3);
  const opIncs = window.map((y) => y.operatingIncome).filter((v): v is number => v !== null);
  if (opIncs.length === 0)
    return { epvPerShare: null, growthPremiumPct: null, note: "n/a — no operating income history" };
  const avgOpInc = opIncs.reduce((a, b) => a + b, 0) / opIncs.length;
  if (avgOpInc <= 0)
    return { epvPerShare: null, growthPremiumPct: null, note: "n/a — no positive operating income (3Y avg)" };

  const taxRates: number[] = [];
  for (const y of window) {
    if (y.netIncome !== null && y.operatingIncome !== null && y.netIncome > 0 && y.operatingIncome > 0) {
      taxRates.push(clamp(1 - y.netIncome / y.operatingIncome, 0.1, 0.35));
    }
  }
  const effectiveTaxRate =
    taxRates.length > 0 ? taxRates.reduce((a, b) => a + b, 0) / taxRates.length : 0.21;

  const wacc = autoWacc(s);
  const nopat = avgOpInc * (1 - effectiveTaxRate);
  const y0 = latest(s)!;
  const epvTotal = nopat / wacc + (y0.cash ?? 0) - (y0.totalDebt ?? 0);
  const epvPerShare = epvTotal / s.sharesOutstanding;

  if (epvPerShare <= 0)
    return { epvPerShare: null, growthPremiumPct: null, note: "n/a — net debt exceeds EPV" };

  const growthPremiumPct = (s.price / epvPerShare - 1) * 100;
  return { epvPerShare, growthPremiumPct };
}

// ---------------------------------------------------------------------------
// Owner Earnings Yield: (NI TTM-or-latest + D&A proxy - maintenance capex) /
// market cap, vs the 10Y treasury.
// ---------------------------------------------------------------------------
export function ownerYield(s: FinancialSnapshot): OwnerYieldOutput {
  const y = latest(s);
  if (!y)
    return { ownerEarnings: null, yieldPct: null, spreadVsTreasuryPp: null, note: "n/a — no financial statements available" };

  const ni = s.ttm?.netIncome ?? y.netIncome;
  if (ni === null)
    return { ownerEarnings: null, yieldPct: null, spreadVsTreasuryPp: null, note: "n/a — missing net income" };

  if (y.ebitda === null || y.operatingIncome === null)
    return {
      ownerEarnings: null,
      yieldPct: null,
      spreadVsTreasuryPp: null,
      note: "n/a — missing EBITDA/operating income for depreciation proxy",
    };
  const dep = y.ebitda - y.operatingIncome;

  if (y.capex === null)
    return { ownerEarnings: null, yieldPct: null, spreadVsTreasuryPp: null, note: "n/a — missing capex" };
  const maintenanceCapex = 0.6 * y.capex;

  const ownerEarnings = ni + dep - maintenanceCapex;

  if (s.marketCap === null)
    return { ownerEarnings, yieldPct: null, spreadVsTreasuryPp: null, note: "n/a — missing market cap" };

  const yieldPct = (ownerEarnings / s.marketCap) * 100;
  const spreadVsTreasuryPp = yieldPct - s.riskFreeRate * 100;
  return { ownerEarnings, yieldPct, spreadVsTreasuryPp };
}

// ---------------------------------------------------------------------------
// Multiples vs Peers & History — EV/EBITDA, P/FCF, P/E, EV/Revenue.
// ---------------------------------------------------------------------------
type MultipleKey = "pe" | "evEbitda" | "evRev" | "pFcf";

const METRIC_DEFS: Record<
  MultipleKey,
  { name: string; useEV: boolean; pick: (y: YearData) => number | null }
> = {
  pe: { name: "P / E", useEV: false, pick: (y) => y.netIncome },
  evEbitda: { name: "EV / EBITDA", useEV: true, pick: (y) => y.ebitda },
  evRev: { name: "EV / Revenue", useEV: true, pick: (y) => y.revenue },
  pFcf: { name: "P / FCF", useEV: false, pick: (y) => y.freeCashFlow },
};

const ORDER: MultipleKey[] = ["evEbitda", "pFcf", "pe", "evRev"];

// Same equity math as valuation.ts's multipleModel: fair = useEV ? mult*m0 -
// debt + cash : mult*m0, per share. Null-safe.
function impliedPrice(
  mult: number | null,
  m0: number | null,
  useEV: boolean,
  debt: number,
  cash: number,
  shares: number
): number | null {
  if (mult === null || m0 === null || m0 <= 0) return null;
  const fair = useEV ? mult * m0 - debt + cash : mult * m0;
  if (fair <= 0) return null;
  return fair / shares;
}

function currentValue(s: FinancialSnapshot, key: MultipleKey, y: YearData): number | null {
  const debt = y.totalDebt ?? 0;
  const cash = y.cash ?? 0;
  switch (key) {
    case "pe":
      return s.trailingEPS !== null && s.trailingEPS > 0 ? s.price / s.trailingEPS : null;
    case "evEbitda":
      return y.ebitda !== null && y.ebitda > 0 && s.marketCap !== null
        ? (s.marketCap + debt - cash) / y.ebitda
        : null;
    case "evRev":
      return y.revenue !== null && y.revenue > 0 && s.marketCap !== null
        ? (s.marketCap + debt - cash) / y.revenue
        : null;
    case "pFcf": {
      const fcf = s.ttm?.freeCashFlow ?? y.freeCashFlow;
      return fcf !== null && fcf > 0 && s.marketCap !== null ? s.marketCap / fcf : null;
    }
  }
}

export function multiplesComparison(s: FinancialSnapshot): MultipleRow[] {
  const y = latest(s);
  const multiples = resolveMultiples(s);
  return ORDER.map((key) => {
    const def = METRIC_DEFS[key];
    if (!y) {
      return {
        key,
        name: def.name,
        current: null,
        ownHistoryMedian: null,
        ownImpliedPrice: null,
        sectorMedian: null,
        sectorImpliedPrice: null,
        premiumToSectorPct: null,
      };
    }
    const debt = y.totalDebt ?? 0;
    const cash = y.cash ?? 0;
    const shares = s.sharesOutstanding;

    const current = currentValue(s, key, y);
    const ownHistoryMedian = medianMultiple(s, def.pick, def.useEV);
    const m0 = def.pick(y);
    const ownImpliedPrice = impliedPrice(ownHistoryMedian, m0, def.useEV, debt, cash, shares);

    const sectorMedian = multiples[key] ?? null;
    const sectorImpliedPrice = impliedPrice(sectorMedian, m0, def.useEV, debt, cash, shares);

    const premiumToSectorPct =
      current !== null && sectorMedian !== null && sectorMedian !== 0
        ? (current / sectorMedian - 1) * 100
        : null;

    return {
      key,
      name: def.name,
      current,
      ownHistoryMedian,
      ownImpliedPrice,
      sectorMedian,
      sectorImpliedPrice,
      premiumToSectorPct,
    };
  });
}
