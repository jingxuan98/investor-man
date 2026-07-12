import { expect, test } from "vitest";
import {
  assumptionProvenance,
  autoNormalGrowth,
  autoWacc,
  classifyStock,
  pegGrowth,
  revenueCagr5y,
  resolveAssumptions,
} from "@/lib/finance/assumptions";
import { cagr, median, linearBand, coefVar, styleComposite } from "@/lib/finance/helpers";
import { FinancialSnapshot } from "@/lib/finance/types";
import { FIX } from "./fixture";

test("cagr basic", () => {
  expect(cagr(121, 100, 2)!).toBeCloseTo(0.1, 10);
  expect(cagr(100, 0, 2)).toBeNull();
});

test("median odd/even", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 2, 3, 4])).toBe(2.5);
});

test("linearBand forward, reverse, clamps", () => {
  expect(linearBand(0.1, 0, 0.2)).toBe(50);
  // NOTE: brief's expected value (2.5-2)/(0.3-2)*100 = -29.41 is unclamped and
  // contradicts linearBand's own documented "clamped" behavior; actual output
  // clamps to 0. Deviation documented in task-3-report.md.
  expect(linearBand(2.5, 2, 0.3)).toBe(0); // reversed, out-of-range clamps to 0
  expect(linearBand(99, 0, 10)).toBe(100);
});

test("coefVar of constant series is 0", () => {
  expect(coefVar([5, 5, 5])).toBe(0);
});

test("auto growth = own 5Y revenue CAGR capped 30: fixture → 10%", () => {
  expect(autoNormalGrowth(FIX)).toBeCloseTo(0.1, 3);
});

test("auto wacc = CAPM w/ 5.5% ERP: 0.04 + 1.2*0.055 = 0.106", () => {
  expect(autoWacc(FIX)).toBeCloseTo(0.106, 10);
});

test("auto wacc caps at 12% (reference calculator's DOM input for NVDA/CAT/TSLA/ASX/DDOG)", () => {
  const hot = { ...FIX, beta: 3.0 }; // raw CAPM 0.205 → calculator cap 0.12
  expect(autoWacc(hot)).toBeCloseTo(0.12, 10);
});

// Build a newest-first N-year growthHistory: revenue at `revCagr`, netIncome
// at `niCagr`, both anchored so the oldest entry = base.
function growthHistory(
  n: number,
  revCagr: number,
  niCagr: number
): FinancialSnapshot["growthHistory"] {
  const rows: NonNullable<FinancialSnapshot["growthHistory"]> = [];
  for (let i = 0; i < n; i++) {
    // i = 0 is newest (highest power), i = n-1 is oldest (power 0).
    const p = n - 1 - i;
    const year = 2025 - i;
    rows.push({
      year,
      revenue: 1000 * Math.pow(1 + revCagr, p),
      netIncome: 100 * Math.pow(1 + niCagr, p),
    });
  }
  return rows;
}

test("revenue seed + PEG growth use 6-endpoint EDGAR window when ≥5 entries", () => {
  // 6 entries → 5 transitions. At a constant per-step CAGR the window size is
  // irrelevant: revenue (1.2^5/1.2^0)^(1/5) − 1 = 0.20; netIncome → 0.30.
  // (6-endpoint window verified against the reference CALCULATOR's DOM inputs:
  // META g1_5 = 18.51 = FY2020→FY2025.)
  const s: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.2, 0.3) };
  expect(revenueCagr5y(s)!).toBeCloseTo(0.2, 6); // EDGAR revenue CAGR
  expect(autoNormalGrowth(s)).toBeCloseTo(0.2, 6); // seed = rev CAGR (≤30 cap)
  expect(pegGrowth(s)!).toBeCloseTo(0.3, 6); // EDGAR net-income CAGR
});

test("growthHistory with 4 entries (<5) is ignored → Yahoo-years 10% seed", () => {
  // <5 EDGAR entries → fall back to s.years (FIX = 4 endpoints, 3 transitions,
  // each step +10%): (1 / (1/1.331))^(1/3) − 1 = 1.331^(1/3) − 1 = 0.10.
  const s: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(4, 0.2, 0.3) };
  expect(revenueCagr5y(s)!).toBeCloseTo(0.1, 6);
  expect(autoNormalGrowth(s)).toBeCloseTo(0.1, 6);
});

test("min-span guard: metric with <4 non-null EDGAR points falls back to s.years", () => {
  // 6-entry history, but revenue is non-null for only the 2 newest years, so the
  // latest-5 window has only 2 non-null revenue points (<4 required) — a
  // truncated series must never masquerade as a long trend. netIncome stays
  // fully populated at 30%. Expected: revenue seed from s.years (10%, as above),
  // PEG growth from the latest-5 EDGAR netIncome window (30%).
  const gh = growthHistory(6, 0.614, 0.3)!.map((r, i) =>
    i < 2 ? r : { ...r, revenue: null }
  );
  const s: FinancialSnapshot = { ...FIX, growthHistory: gh };
  expect(revenueCagr5y(s)!).toBeCloseTo(0.1, 6);
  expect(pegGrowth(s)!).toBeCloseTo(0.3, 6);
});

test("resolveAssumptions applies overrides", () => {
  const a = resolveAssumptions(FIX, { wacc: 0.15 });
  expect(a.wacc).toBe(0.15);
  expect(a.terminalGrowth).toBe(0.04);
  expect(a.hHalfLife).toBe(4);
});

// --- textbook (no caps) variant --------------------------------------------

test("textbook auto WACC: pure CAPM, no cap — beta 3 → rf 0.04 + 3*0.055 = 0.205", () => {
  const hot = { ...FIX, beta: 3.0 };
  expect(autoWacc(hot, "textbook")).toBeCloseTo(0.205, 10);
  // calibrated stays capped at 0.12 for the same input
  expect(autoWacc(hot, "calibrated")).toBeCloseTo(0.12, 10);
});

test("textbook auto WACC: 0.1% sanity floor only (no 4% floor)", () => {
  const negRf = { ...FIX, beta: -1, riskFreeRate: 0.001 }; // raw CAPM ≈ -0.054
  expect(autoWacc(negRf, "textbook")).toBeCloseTo(0.001, 10);
  expect(autoWacc(negRf, "calibrated")).toBeCloseTo(0.04, 10); // calibrated floor
});

test("textbook auto growth seed: uncapped and unfloored (raw CAGR)", () => {
  const s: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.5, 0.5) };
  expect(autoNormalGrowth(s, "textbook")).toBeCloseTo(0.5, 6); // uncapped, no 30% ceiling
  expect(autoNormalGrowth(s, "calibrated")).toBeCloseTo(0.3, 6); // calibrated caps at 30%
});

test("textbook auto growth seed: no history → 5% default (same as calibrated)", () => {
  const s: FinancialSnapshot = { ...FIX, years: [], growthHistory: null };
  expect(autoNormalGrowth(s, "textbook")).toBe(0.05);
});

test("resolveAssumptions: textbook terminal growth default is 2.5%, calibrated stays 4%", () => {
  const tb = resolveAssumptions(FIX, {}, "textbook");
  const cal = resolveAssumptions(FIX, {}, "calibrated");
  expect(tb.terminalGrowth).toBeCloseTo(0.025, 10);
  expect(cal.terminalGrowth).toBeCloseTo(0.04, 10);
});

test("resolveAssumptions: knob overrides win in both variants", () => {
  const tb = resolveAssumptions(FIX, { wacc: 0.2, terminalGrowth: 0.06 }, "textbook");
  expect(tb.wacc).toBe(0.2);
  expect(tb.terminalGrowth).toBe(0.06);
});

// --- classifyStock -----------------------------------------------------

test("classifyStock: 5Y revenue CAGR 20% (≥15%) → growth", () => {
  const s: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.2, 0.2) };
  expect(revenueCagr5y(s)!).toBeCloseTo(0.2, 6);
  expect(classifyStock(s)).toBe("growth");
});

test("classifyStock: FIX at 10% revenue CAGR (7-15%) → balanced", () => {
  expect(revenueCagr5y(FIX)!).toBeCloseTo(0.1, 3);
  expect(classifyStock(FIX)).toBe("balanced");
});

test("classifyStock: 5Y revenue CAGR 3% (<7%) → mature", () => {
  const s: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.03, 0.03) };
  expect(revenueCagr5y(s)!).toBeCloseTo(0.03, 6);
  expect(classifyStock(s)).toBe("mature");
});

test("classifyStock: no growth history at all (null CAGR) → mature", () => {
  const s: FinancialSnapshot = { ...FIX, years: [], growthHistory: null };
  expect(revenueCagr5y(s)).toBeNull();
  expect(classifyStock(s)).toBe("mature");
});

// --- styleComposite ------------------------------------------------------

test("styleComposite: ≥5 values → trimmed mean (drop min+max), matches existing trimmedMean semantics", () => {
  // sorted [1,2,3,4,5] → drop 1 and 5 → mean of [2,3,4] = 3
  expect(styleComposite([3, 1, 5, 2, 4])).toEqual({ value: 3, method: "trimmed" });
});

test("styleComposite: 3-4 values → plain mean", () => {
  expect(styleComposite([1, 2, 3, 4])).toEqual({ value: 2.5, method: "mean" });
  expect(styleComposite([1, 2, 3])).toEqual({ value: 2, method: "mean" });
});

test("styleComposite: ≤2 values → n/a", () => {
  expect(styleComposite([1, 2])).toEqual({ value: null, method: null });
  expect(styleComposite([])).toEqual({ value: null, method: null });
});

// --- assumptionProvenance ------------------------------------------------
// Task 38 part B: users must see WHAT growth/discount figure the auto
// pipeline resolved to and WHERE it came from — these tests pin the exact
// contract the Intrinsic Value page's Assumptions strip reads.

test("assumptionProvenance on the FIX fixture: Yahoo-years source, no clamp, matches autoNormalGrowth/autoWacc", () => {
  const p = assumptionProvenance(FIX, "calibrated");
  // FIX has no growthHistory → falls back to s.years (4 endpoints, 2022-2025).
  expect(p.growthSource).toBe("yahoo");
  expect(p.spanYears).toEqual([2022, 2025]);
  expect(p.growthRaw).toBeCloseTo(0.1, 3);
  expect(p.growthUsed).toBeCloseTo(autoNormalGrowth(FIX, "calibrated"), 10);
  // 10% is within [2%, 30%] — nothing was clamped.
  expect(p.clampNote).toBeNull();
  expect(p.wacc).toBeCloseTo(autoWacc(FIX, "calibrated"), 10);
  expect(p.waccParts).toEqual({ rf: FIX.riskFreeRate, beta: FIX.beta, erp: 0.055, clamped: false });
  expect(p.pegGrowth).toBeCloseTo(pegGrowth(FIX)!, 10);
  expect(p.pegSource).toBe("yahoo");
  expect(p.terminal).toBeCloseTo(0.04, 10);
});

test("assumptionProvenance: EDGAR window (≥5 entries) reports source 'sec' and its own FY span", () => {
  const s: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.2, 0.3) };
  const p = assumptionProvenance(s, "calibrated");
  expect(p.growthSource).toBe("sec");
  expect(p.spanYears).toEqual([2020, 2025]); // 6 endpoints, newest 2025 → oldest 2020
  expect(p.growthRaw).toBeCloseTo(0.2, 6);
  expect(p.pegGrowth).toBeCloseTo(0.3, 6);
  expect(p.pegSource).toBe("sec");
});

test("assumptionProvenance: no history at all → 'default' source, null span, 5% growth, no clamp note", () => {
  const s: FinancialSnapshot = { ...FIX, years: [], growthHistory: null };
  const p = assumptionProvenance(s, "calibrated");
  expect(p.growthSource).toBe("default");
  expect(p.spanYears).toBeNull();
  expect(p.growthRaw).toBeNull();
  expect(p.growthUsed).toBe(0.05);
  expect(p.clampNote).toBeNull(); // nothing to compare against → no clamp claim
});

test("assumptionProvenance: calibrated clamp notes — hyper-growth capped at 30%, near-zero floored at 2%", () => {
  const hot: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.5, 0.5) };
  const cold: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.01, 0.01) };
  const pHot = assumptionProvenance(hot, "calibrated");
  const pCold = assumptionProvenance(cold, "calibrated");
  expect(pHot.growthRaw).toBeCloseTo(0.5, 6);
  expect(pHot.growthUsed).toBeCloseTo(0.3, 6);
  expect(pHot.clampNote).toBe("capped at 30%");
  expect(pCold.growthRaw).toBeCloseTo(0.01, 6);
  expect(pCold.growthUsed).toBeCloseTo(0.02, 6);
  expect(pCold.clampNote).toBe("floored at 2%");
});

test("assumptionProvenance: textbook variant is never clamped (growthUsed == growthRaw exactly) and uses its own 2.5% terminal default", () => {
  const hot: FinancialSnapshot = { ...FIX, growthHistory: growthHistory(6, 0.5, 0.5) };
  const p = assumptionProvenance(hot, "textbook");
  expect(p.growthUsed).toBeCloseTo(p.growthRaw!, 10);
  expect(p.clampNote).toBeNull();
  expect(p.terminal).toBeCloseTo(0.025, 10);
});

test("assumptionProvenance: WACC clamp — calibrated caps a hot beta at 12%, textbook doesn't", () => {
  const hotBeta = { ...FIX, beta: 3.0 };
  const pCal = assumptionProvenance(hotBeta, "calibrated");
  const pTb = assumptionProvenance(hotBeta, "textbook");
  expect(pCal.wacc).toBeCloseTo(0.12, 10);
  expect(pCal.waccParts.clamped).toBe(true);
  expect(pTb.wacc).toBeCloseTo(0.205, 10); // 0.04 + 3.0 * 0.055, uncapped
  expect(pTb.waccParts.clamped).toBe(false);
});

test("assumptionProvenance: pegSource falls back to revenue's source when net-income CAGR is incomputable anywhere", () => {
  // netIncome is null both in the EDGAR window AND in the Yahoo statement
  // years, so niProv can only resolve to null — pegGrowth must fall back to
  // revenueCagr5y (and report ITS source), not attribute revenue's number to
  // a phantom net-income read.
  const gh = growthHistory(6, 0.15, 0.15)!.map((r) => ({ ...r, netIncome: null }));
  const yearsNoNi = FIX.years.map((y) => ({ ...y, netIncome: null }));
  const s: FinancialSnapshot = { ...FIX, growthHistory: gh, years: yearsNoNi };
  const p = assumptionProvenance(s, "calibrated");
  expect(p.pegGrowth).toBeCloseTo(0.15, 6);
  expect(p.pegSource).toBe("sec"); // matches revenueCagr5y's own EDGAR source
  expect(p.growthSource).toBe("sec");
});
