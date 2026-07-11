import { FinancialSnapshot } from "./types";
import { autoWacc, revenueCagr5y } from "./assumptions";
import { clamp } from "./helpers";

// ---------------------------------------------------------------------------
// Quality Gate — replicates the reference site's 4-sub-factor × 25pt quality
// system. The four scoring kernels below were reverse-engineered (FITTED) from
// 9 real extracted samples; see tests/gate.test.ts for the acceptance table.
// PURE module — no I/O, matching the rest of lib/finance.
// ---------------------------------------------------------------------------

export interface GateFactor {
  key: string; // "roicVsWacc" | "grossMarginTrend" | "revenueQuality" | "capitalAllocation"
  name: string; // display name
  score: number; // 0-25
  status: string; // e.g. "Eroding economic value"
  readings: { label: string; value: string }[]; // display rows
}
export interface GateOutput {
  factors: GateFactor[];
  score: number; // 0-100 (sum)
  grade: "A" | "B" | "C" | "D" | "F";
  passed: boolean; // score >= 60
  passThreshold: 60;
}

const TAX_RATE = 0.21;

// --- Scoring kernels (exported for the acceptance test table) --------------

// Q-01 ROIC vs WACC — exact fit, 9/9 samples.
export function scoreRoicVsWacc(
  spreadBps: number,
  trend: "widening" | "compressing" | "stable"
): number {
  let bucket: number;
  if (spreadBps <= -200) bucket = 0;
  else if (spreadBps < 0) bucket = 5;
  else if (spreadBps < 200) bucket = 10;
  else if (spreadBps < 500) bucket = 15;
  else if (spreadBps < 1000) bucket = 20;
  else bucket = 25;
  if (bucket === 0) return 0;
  const mod = trend === "widening" ? 2 : trend === "compressing" ? -2 : 0;
  return clamp(bucket + mod, 0, 25);
}

// Q-02 Gross Margin Trend — approximate fit (±2 vs reference).
// gmLatestPct is the latest gross margin in PERCENT (e.g. 45.6).
export function scoreGrossMargin(changeBps: number, gmLatestPct: number): number {
  if (changeBps <= -250) {
    return clamp(Math.round(4 + (gmLatestPct - 20) / 10), 2, 8);
  }
  return clamp(Math.round(12 + changeBps / 30 + (gmLatestPct - 40) / 10), 0, 25);
}

// Q-03 Revenue Quality — exact fit, 9/9 samples.
export function scoreRevenueQuality(
  positiveYears: number,
  denominator: number,
  cagr5yPct: number
): number {
  const baseTable: Record<number, number> = { 0: 2, 1: 4, 2: 7, 3: 11, 4: 18 };
  // Scale to a /4 basis when fewer than 4 transitions are available (e.g. a
  // 3/3 all-positive record is treated as 4/4 → 18).
  const denom = denominator > 0 ? denominator : 4;
  const equiv = clamp(Math.round((positiveYears / denom) * 4), 0, 4);
  let score = baseTable[equiv];
  // Growth bonus only when the positive-year count clears 75% of the window.
  if (positiveYears >= Math.ceil(0.75 * denom)) {
    if (cagr5yPct >= 10) score += 5;
    else if (cagr5yPct >= 5) score += 3;
  }
  return score;
}

// Q-04 Capital Allocation — exact fit, 9/9 samples.
export function scoreCapitalAllocation(
  positiveFcfYears: number,
  denominator: number,
  buybackYieldPct: number
): number {
  const baseTable: Record<number, number> = { 0: 3, 1: 5, 2: 6, 3: 8, 4: 10, 5: 12 };
  const denom = denominator > 0 ? denominator : 5;
  let base: number;
  if (denom === 5) {
    base = baseTable[clamp(positiveFcfYears, 0, 5)];
  } else if (positiveFcfYears >= denom) {
    base = 12; // all observations positive
  } else {
    const equiv = clamp(Math.round((positiveFcfYears / denom) * 5), 0, 5);
    base = Math.max(3, baseTable[equiv]);
  }
  if (buybackYieldPct >= 1.0) base += 4;
  return base;
}

// --- Status text per factor -------------------------------------------------

function statusRoic(score: number): string {
  if (score >= 20) return "Wide & widening moat";
  if (score >= 15) return "Value creator";
  if (score >= 10) return "Marginal value creation";
  return "Eroding economic value";
}
function statusGrossMargin(score: number): string {
  if (score >= 20) return "Pricing power expanding";
  if (score >= 12) return "Stable & sufficient";
  if (score >= 8) return "Mixed signals";
  return "Compressing margins";
}
function statusRevenue(score: number): string {
  if (score >= 21) return "Durable, consistent growth";
  if (score >= 14) return "Reasonably consistent";
  if (score >= 8) return "Choppy growth";
  return "Erratic / declining";
}
function statusCapital(score: number): string {
  if (score >= 16) return "Disciplined allocation";
  if (score >= 10) return "Mixed track record";
  return "Concerning capital decisions";
}

// --- Small display + math helpers ------------------------------------------

function pct1(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
// Exported so story.ts (The Story tab) can compute the same live ROIC
// reading used in the Quality Gate's "ROIC vs WACC" factor, instead of
// re-deriving it (or fragile-parsing the factor's formatted `readings`).
export function roicOfYear(y: FinancialSnapshot["years"][number]): number | null {
  if (y.equity === null || y.operatingIncome === null) return null;
  const ic = y.equity + (y.totalDebt ?? 0) - (y.cash ?? 0);
  if (ic <= 0) return null;
  return (y.operatingIncome * (1 - TAX_RATE)) / ic;
}

const NA_EMPTY = "n/a — no financial statements available";

function emptyFactor(key: string, name: string): GateFactor {
  return { key, name, score: 0, status: NA_EMPTY, readings: [] };
}

// --- Main entry -------------------------------------------------------------

export function computeGate(s: FinancialSnapshot): GateOutput {
  if (s.years.length === 0) {
    const factors = [
      emptyFactor("roicVsWacc", "ROIC vs WACC"),
      emptyFactor("grossMarginTrend", "Gross Margin Trend"),
      emptyFactor("revenueQuality", "Revenue Quality"),
      emptyFactor("capitalAllocation", "Capital Allocation"),
    ];
    return { factors, score: 0, grade: "F", passed: false, passThreshold: 60 };
  }

  const latest = s.years[0];
  const oldest = s.years[s.years.length - 1];
  const factors: GateFactor[] = [];

  // ---- Q-01 ROIC vs WACC ----
  {
    const roic = roicOfYear(latest);
    const wacc = autoWacc(s);
    if (roic === null) {
      factors.push({
        key: "roicVsWacc",
        name: "ROIC vs WACC",
        score: 0,
        status: "n/a — ROIC unavailable",
        readings: [{ label: "WACC (est)", value: pct1(wacc) }],
      });
    } else {
      const spreadBps = (roic - wacc) * 10000;
      const roicOld = roicOfYear(oldest);
      let trend: "widening" | "compressing" | "stable" = "stable";
      if (roicOld !== null) {
        const d = roic - roicOld;
        trend = d > 0.01 ? "widening" : d < -0.01 ? "compressing" : "stable";
      }
      const score = scoreRoicVsWacc(spreadBps, trend);
      factors.push({
        key: "roicVsWacc",
        name: "ROIC vs WACC",
        score,
        status: statusRoic(score),
        readings: [
          { label: "ROIC", value: pct1(roic) },
          { label: "WACC (est)", value: pct1(wacc) },
          { label: "Spread", value: `${spreadBps >= 0 ? "+" : ""}${Math.round(spreadBps)} bps` },
          { label: "Trend", value: trend },
        ],
      });
    }
  }

  // ---- Q-02 Gross Margin Trend ----
  {
    const gmLatest =
      latest.revenue && latest.grossProfit !== null ? latest.grossProfit / latest.revenue : null;
    const gmOldest =
      oldest.revenue && oldest.grossProfit !== null ? oldest.grossProfit / oldest.revenue : null;
    if (gmLatest === null) {
      factors.push({
        key: "grossMarginTrend",
        name: "Gross Margin Trend",
        score: 0,
        status: "n/a — margin data unavailable",
        readings: [],
      });
    } else {
      const changeBps = gmOldest !== null ? (gmLatest - gmOldest) * 10000 : 0;
      const direction =
        changeBps >= 150 ? "expanding" : changeBps <= -150 ? "compressing" : "stable";
      const score = scoreGrossMargin(changeBps, gmLatest * 100);
      factors.push({
        key: "grossMarginTrend",
        name: "Gross Margin Trend",
        score,
        status: statusGrossMargin(score),
        readings: [
          { label: "Gross margin", value: pct1(gmLatest) },
          { label: "Change", value: `${changeBps >= 0 ? "+" : ""}${Math.round(changeBps)} bps` },
          { label: "Direction", value: direction },
        ],
      });
    }
  }

  // ---- Q-03 Revenue Quality ----
  {
    // Prefer EDGAR revenue history when it has ≥5 entries; else use statement years.
    const useEdgar = s.growthHistory !== null && s.growthHistory.length >= 5;
    const revSeries: (number | null)[] = useEdgar
      ? s.growthHistory!.map((r) => r.revenue)
      : s.years.map((y) => y.revenue);
    // Newest-first; take up to 5 points → up to 4 most-recent transitions.
    const revs = revSeries.slice(0, 5);
    const transitions: number[] = [];
    for (let i = 0; i < revs.length - 1; i++) {
      const newer = revs[i];
      const older = revs[i + 1];
      if (newer !== null && older !== null && older !== 0) {
        transitions.push(newer / older - 1);
      }
    }
    const denominator = Math.min(transitions.length, 4);
    if (denominator === 0) {
      factors.push({
        key: "revenueQuality",
        name: "Revenue Quality",
        score: 0,
        status: "n/a — insufficient revenue history",
        readings: [],
      });
    } else {
      const window = transitions.slice(0, denominator);
      const positiveYears = window.filter((g) => g > 0).length;
      const cagr = revenueCagr5y(s);
      const cagr5yPct = cagr === null ? 0 : cagr * 100;
      const latestYoY = window[0] * 100;
      const score = scoreRevenueQuality(positiveYears, denominator, cagr5yPct);
      const ratio = positiveYears / denominator;
      const tier = ratio >= 1.0 ? "High" : ratio >= 0.75 ? "Medium" : "Low";
      factors.push({
        key: "revenueQuality",
        name: "Revenue Quality",
        score,
        status: statusRevenue(score),
        readings: [
          { label: "Positive years", value: `${positiveYears} / ${denominator}` },
          { label: "5Y CAGR", value: `${cagr5yPct.toFixed(1)}%` },
          { label: "Latest YoY", value: `${latestYoY.toFixed(1)}%` },
          { label: "Consistency", value: tier },
        ],
      });
    }
  }

  // ---- Q-04 Capital Allocation ----
  {
    // Up to 5 most-recent FCF observations: TTM (if present) counts as one,
    // then statement years newest-first.
    const fcfObs: number[] = [];
    if (s.ttm?.freeCashFlow != null) fcfObs.push(s.ttm.freeCashFlow);
    for (const y of s.years) {
      if (fcfObs.length >= 5) break;
      if (y.freeCashFlow !== null) fcfObs.push(y.freeCashFlow);
    }
    const obs = fcfObs.slice(0, 5);
    const denominator = obs.length;
    if (denominator === 0) {
      factors.push({
        key: "capitalAllocation",
        name: "Capital Allocation",
        score: 0,
        status: "n/a — cash-flow data unavailable",
        readings: [],
      });
    } else {
      const positiveFcfYears = obs.filter((f) => f > 0).length;

      // Annualized buyback yield from share-count reduction, floored at 0.
      const latestShares = latest.sharesOutstanding ?? s.sharesOutstanding;
      const oldestShares = oldest.sharesOutstanding ?? s.sharesOutstanding;
      const yearsSpanned = latest.year - oldest.year;
      let buybackYieldPct = 0;
      if (latestShares > 0 && yearsSpanned > 0) {
        buybackYieldPct = Math.max(
          0,
          ((oldestShares - latestShares) / latestShares / yearsSpanned) * 100
        );
      }
      const score = scoreCapitalAllocation(positiveFcfYears, denominator, buybackYieldPct);
      factors.push({
        key: "capitalAllocation",
        name: "Capital Allocation",
        score,
        status: statusCapital(score),
        readings: [
          { label: "Positive FCF years", value: `${positiveFcfYears} / ${denominator}` },
          { label: "Buyback yield", value: `${buybackYieldPct.toFixed(1)}%` },
        ],
      });
    }
  }

  const score = factors.reduce((a, f) => a + f.score, 0);
  const grade: GateOutput["grade"] =
    score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : score >= 30 ? "D" : "F";
  return { factors, score, grade, passed: score >= 60, passThreshold: 60 };
}
