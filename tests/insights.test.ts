import { expect, test } from "vitest";
import {
  epv,
  generalThreeStagePv,
  multiplesComparison,
  ownerYield,
  reverseDcf,
} from "@/lib/finance/insights";
import { threeStagePv, medianMultiple } from "@/lib/finance/valuation";
import { autoWacc } from "@/lib/finance/assumptions";
import { FIX } from "./fixture";

// ---------------------------------------------------------------------------
// generalThreeStagePv
// ---------------------------------------------------------------------------

test("generalThreeStagePv: equals threeStagePv when g2 = 0.7*g1 and g3 = terminal default", () => {
  const base = 1000;
  const g1 = 0.15;
  const wacc = 0.09;
  const terminalGrowth = 0.04;

  const expected = threeStagePv(base, g1, wacc, terminalGrowth);
  const actual = generalThreeStagePv(base, g1, 0.7 * g1, terminalGrowth, wacc);

  expect(expected).not.toBeNull();
  expect(actual).not.toBeNull();
  expect(actual!).toBeCloseTo(expected!, 8);
});

test("generalThreeStagePv: independent stage growth rates diverge from threeStagePv", () => {
  const base = 1000;
  const wacc = 0.09;
  // g6-10 set independently (not 0.7*g1) -> must differ from threeStagePv's
  // hard-coded 0.7*g fade.
  const viaGeneral = generalThreeStagePv(base, 0.15, 0.05, 0.04, wacc);
  const viaThreeStage = threeStagePv(base, 0.15, wacc, 0.04);
  expect(viaGeneral).not.toBeNull();
  expect(viaThreeStage).not.toBeNull();
  expect(viaGeneral).not.toBeCloseTo(viaThreeStage!, 2);
});

test("generalThreeStagePv: non-positive discount rate -> null", () => {
  expect(generalThreeStagePv(1000, 0.1, 0.1, 0.04, 0)).toBeNull();
  expect(generalThreeStagePv(1000, 0.1, 0.1, 0.04, -0.01)).toBeNull();
});

// ---------------------------------------------------------------------------
// reverseDcf
// ---------------------------------------------------------------------------

test("reverseDcf: solves g* exactly when marketCap = threeStagePv(g*) + cash - debt", () => {
  const wacc = autoWacc(FIX); // beta 1.2, rf 0.04 -> clamp(0.04+1.2*0.055, .04,.12) = 0.106
  expect(wacc).toBeCloseTo(0.106, 10);

  const gStar = 0.15;
  const base = FIX.years[0].operatingCashFlow!; // 300, ttm null -> FY base
  const pv = threeStagePv(base, gStar, wacc)!;
  const equity = pv + (FIX.years[0].cash ?? 0) - (FIX.years[0].totalDebt ?? 0);

  const withMcap = structuredClone(FIX);
  withMcap.marketCap = equity;

  const out = reverseDcf(withMcap);
  expect(out.impliedGrowth).not.toBeNull();
  expect(out.impliedGrowth!).toBeCloseTo(gStar, 3);
});

test("reverseDcf: marketCap null -> null", () => {
  const bad = structuredClone(FIX);
  bad.marketCap = null;
  const out = reverseDcf(bad);
  expect(out.impliedGrowth).toBeNull();
  expect(out.note).toMatch(/market cap/i);
});

test("reverseDcf: negative base operating cash flow -> null", () => {
  const bad = structuredClone(FIX);
  bad.years[0].operatingCashFlow = -50;
  const out = reverseDcf(bad);
  expect(out.impliedGrowth).toBeNull();
  expect(out.note).toMatch(/operating cash flow/i);
});

// ---------------------------------------------------------------------------
// epv
// ---------------------------------------------------------------------------

test("epv: hand-computed for FIX", () => {
  // FIX years (newest first), f1=1, f2=1/1.1, f3=1/1.21; opInc = 280f, NI = 200f
  // -> NI/opInc = 200/280 = 5/7 constant across years, so tax rate clamps to
  // the same 1 - 5/7 = 2/7 (~0.2857) in bounds [0.10, 0.35] every year.
  const f1 = 1;
  const f2 = 1 / 1.1;
  const f3 = 1 / 1.21;
  const opIncs = [280 * f1, 280 * f2, 280 * f3];
  const avgOpInc = opIncs.reduce((a, b) => a + b, 0) / 3;
  const taxRate = 1 - 5 / 7; // = 2/7, within [0.10, 0.35]
  const wacc = autoWacc(FIX); // 0.106
  const nopat = avgOpInc * (1 - taxRate);
  const epvTotal = nopat / wacc + FIX.years[0].cash! - FIX.years[0].totalDebt!;
  const epvPerShare = epvTotal / FIX.sharesOutstanding;
  const growthPremiumPct = (FIX.price / epvPerShare - 1) * 100;

  const out = epv(FIX);
  expect(out.epvPerShare).not.toBeNull();
  expect(out.epvPerShare!).toBeCloseTo(epvPerShare, 6);
  expect(out.growthPremiumPct!).toBeCloseTo(growthPremiumPct, 6);
});

test("epv: no positive operating income -> null", () => {
  const bad = structuredClone(FIX);
  bad.years = bad.years.map((y) => ({ ...y, operatingIncome: -10 }));
  const out = epv(bad);
  expect(out.epvPerShare).toBeNull();
  expect(out.note).toMatch(/operating income/i);
});

// ---------------------------------------------------------------------------
// ownerYield
// ---------------------------------------------------------------------------

test("ownerYield: hand-computed for FIX", () => {
  // ownerEarnings = NI(200) + dep(ebitda 350 - opInc 280 = 70) - maintCapex(0.6*50=30) = 240
  const ownerEarnings = 200 + (350 - 280) - 0.6 * 50;
  expect(ownerEarnings).toBe(240);
  const yieldPct = (ownerEarnings / FIX.marketCap!) * 100; // 240/4000*100 = 6
  const spreadVsTreasuryPp = yieldPct - FIX.riskFreeRate * 100; // 6 - 4 = 2

  const out = ownerYield(FIX);
  expect(out.ownerEarnings).toBeCloseTo(240, 6);
  expect(out.yieldPct).toBeCloseTo(6, 6);
  expect(out.spreadVsTreasuryPp).toBeCloseTo(2, 6);
});

test("ownerYield: missing marketCap -> yieldPct/spread null but ownerEarnings still computed", () => {
  const bad = structuredClone(FIX);
  bad.marketCap = null;
  const out = ownerYield(bad);
  expect(out.ownerEarnings).toBeCloseTo(240, 6);
  expect(out.yieldPct).toBeNull();
  expect(out.spreadVsTreasuryPp).toBeNull();
  expect(out.note).toMatch(/market cap/i);
});

// ---------------------------------------------------------------------------
// multiplesComparison
// ---------------------------------------------------------------------------

function row(rows: ReturnType<typeof multiplesComparison>, key: string) {
  const r = rows.find((r) => r.key === key)!;
  expect(r, key).toBeDefined();
  return r;
}

test("multiplesComparison: FIX sector Technology -> sector columns match SECTOR_MULTIPLES table", () => {
  const tech = structuredClone(FIX);
  tech.sector = "Technology";
  const rows = multiplesComparison(tech);

  // current: pe = price/EPS = 40/2 = 20; evEbitda = (4000+400-200)/350 = 12;
  // evRev = (4000+400-200)/1000 = 4.2; pFcf = 4000/250 = 16
  expect(row(rows, "pe").current).toBeCloseTo(20, 6);
  expect(row(rows, "evEbitda").current).toBeCloseTo(12, 6);
  expect(row(rows, "evRev").current).toBeCloseTo(4.2, 6);
  expect(row(rows, "pFcf").current).toBeCloseTo(16, 6);

  // sector medians extracted verbatim (Technology row of the spec table)
  expect(row(rows, "pe").sectorMedian).toBe(28);
  expect(row(rows, "evEbitda").sectorMedian).toBe(18);
  expect(row(rows, "evRev").sectorMedian).toBe(5.5);
  expect(row(rows, "pFcf").sectorMedian).toBe(30);

  // sector-implied prices: same equity math as valuation.ts's multipleModel
  // pe: 28*200(NI)/100 shares = 56
  expect(row(rows, "pe").sectorImpliedPrice).toBeCloseTo(56, 6);
  // evEbitda: (18*350 - 400 + 200)/100 = 61
  expect(row(rows, "evEbitda").sectorImpliedPrice).toBeCloseTo(61, 6);
  // evRev: (5.5*1000 - 400 + 200)/100 = 53 (cross-checked vs valuation.test.ts)
  expect(row(rows, "evRev").sectorImpliedPrice).toBeCloseTo(53, 6);
  // pFcf: (30*250)/100 = 75 (cross-checked vs valuation.test.ts)
  expect(row(rows, "pFcf").sectorImpliedPrice).toBeCloseTo(75, 6);

  // own-history median for pe is exactly 20 in this fixture: NI scales by the
  // same factor f as price every year, so cap_t/NI_t = 4000f/200f = 20 always.
  expect(row(rows, "pe").ownHistoryMedian).toBeCloseTo(20, 6);
  expect(row(rows, "pe").ownImpliedPrice).toBeCloseTo(40, 6); // 20*200/100 = price

  // own-history median cross-checked directly against the exported medianMultiple
  expect(row(rows, "evEbitda").ownHistoryMedian).toBeCloseTo(
    medianMultiple(tech, (y) => y.ebitda, true)!,
    10
  );
  expect(row(rows, "evRev").ownHistoryMedian).toBeCloseTo(
    medianMultiple(tech, (y) => y.revenue, true)!,
    10
  );
  expect(row(rows, "pFcf").ownHistoryMedian).toBeCloseTo(
    medianMultiple(tech, (y) => y.freeCashFlow, false)!,
    10
  );

  expect(row(rows, "pe").premiumToSectorPct).toBeCloseTo((20 / 28 - 1) * 100, 6);
});

test("multiplesComparison: industry override takes priority over sector for its defined fields", () => {
  const meta = structuredClone(FIX);
  meta.sector = "Communication Services"; // sector evRev = 3.0, pFcf = 22
  meta.industry = "Internet Content & Information"; // industry evRev = 5.3, pFcf = 20
  const rows = multiplesComparison(meta);
  expect(row(rows, "evRev").sectorMedian).toBe(5.3);
  expect(row(rows, "pFcf").sectorMedian).toBe(20);
  // pe/evEbitda aren't in the industry table -> fall through to the sector's
  expect(row(rows, "pe").sectorMedian).toBe(22);
  expect(row(rows, "evEbitda").sectorMedian).toBe(13);
});

test("multiplesComparison: sector null -> all sector columns null, other fields still populated", () => {
  const rows = multiplesComparison(FIX); // FIX.sector = null
  for (const r of rows) {
    expect(r.sectorMedian, r.key).toBeNull();
    expect(r.sectorImpliedPrice, r.key).toBeNull();
    expect(r.premiumToSectorPct, r.key).toBeNull();
    expect(r.current, r.key).not.toBeNull();
    expect(r.ownHistoryMedian, r.key).not.toBeNull();
  }
});

test("multiplesComparison: metric fully missing -> that row's dependent fields null (sectorMedian lookup unaffected)", () => {
  const bad = structuredClone(FIX);
  bad.sector = "Technology";
  bad.ttm = null;
  bad.years = bad.years.map((y) => ({ ...y, freeCashFlow: null }));
  const rows = multiplesComparison(bad);
  const pFcfRow = row(rows, "pFcf");
  expect(pFcfRow.current).toBeNull();
  expect(pFcfRow.ownHistoryMedian).toBeNull();
  expect(pFcfRow.ownImpliedPrice).toBeNull();
  expect(pFcfRow.sectorImpliedPrice).toBeNull();
  expect(pFcfRow.premiumToSectorPct).toBeNull();
  // sectorMedian is a static lookup independent of company data - unaffected
  expect(pFcfRow.sectorMedian).toBe(30);

  // other rows unaffected
  expect(row(rows, "pe").current).not.toBeNull();
});
