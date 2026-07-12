import { expect, test } from "vitest";
import { computeValuation, textbookPv } from "@/lib/finance/valuation";
import { FIX } from "./fixture";

const ZERO_G = { normalGrowth: 0, terminalGrowth: 0, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };

function model(out: ReturnType<typeof computeValuation>, key: string) {
  const m = out.models.find((m) => m.key === key)!;
  expect(m, key).toBeDefined();
  return m;
}

// Three-stage, NO terminal value: zero growth everywhere → flat 20y annuity.
// a20 = (1 - 1.1^-20)/0.1 = 8.513563719758558
test("DCF-20 zero-growth = 20y annuity: (300*a20 + 200 - 400)/100", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "dcf20").value!).toBeCloseTo(23.540691159275674, 6);
});

test("DFCF-20 zero-growth: (250*a20 + 200 - 400)/100", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "dfcf20").value!).toBeCloseTo(19.283909299396395, 6);
});

test("DNI-20 zero-growth: 200*a20/100 (no debt adj)", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "dni20").value!).toBeCloseTo(17.027127439517116, 6);
});

test("H-model zero-growth: FCF/wacc/shares = 25", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "hmodel").value!).toBeCloseTo(25, 6);
});

test("PEG-implied: EPS 2 * g*100 with manual g=10% override → 20", () => {
  const out = computeValuation(FIX, { ...ZERO_G, normalGrowth: 0.1 });
  expect(model(out, "peg").value!).toBeCloseTo(20, 6);
});

test("Graham: EPS*(8.5+2g)*4.4/5.0 (fixed Y), g=10 → 50.16", () => {
  const out = computeValuation(FIX, { ...ZERO_G, normalGrowth: 0.1 });
  expect(model(out, "graham").value!).toBeCloseTo(50.16, 2);
});

test("EV/EBITDA uses median historical multiple", () => {
  // fixture: every year mktcap = 40f*100 = 4000f, debt 400, cash 200, ebitda 350f
  // multiple_f = (4000f + 200)/... careful: EV_t = cap_t + debt - cash = 4000f + 200
  // ratio_t = (4000f+200)/(350f). For f=1: 4200/350 = 12; f=1/1.1: (3636.36+200)/318.18 = 12.057...
  // With varying f the ratios differ slightly; assert value = medianMultiple*350 - 400 + 200, /100
  const out = computeValuation(FIX, ZERO_G);
  const v = model(out, "evEbitda").value!;
  expect(v).toBeGreaterThan(35); // ~ (12.1*350 - 200)/100 ≈ 40.3
  expect(v).toBeLessThan(45);
});

test("terminal growth >= wacc → H-model null; DCFs survive (no Gordon TV anymore)", () => {
  const out = computeValuation(FIX, { ...ZERO_G, terminalGrowth: 0.12, wacc: 0.1 });
  expect(model(out, "hmodel").value).toBeNull();
  expect(model(out, "hmodel").note).toMatch(/terminal/i);
  expect(model(out, "dcf20").value).not.toBeNull();
});

test("three-stage path: g=10% → y1-5 10%, y6-10 7%, y11-20 terminal 4%", () => {
  // hand-computed: base 100 series PV at wacc 10% = 1608.5860215469163... but
  // through the engine: dni20 with base 200 → 2*that/100 per share, no adj.
  const out = computeValuation(FIX, { normalGrowth: 0.1, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 });
  expect(model(out, "dni20").value!).toBeCloseTo((200 * 16.085860215469163) / 100, 4);
});

test("TTM bases preferred over latest FY when present", () => {
  const withTtm = structuredClone(FIX);
  withTtm.ttm = { operatingCashFlow: 600, freeCashFlow: 500, netIncome: 400 };
  const out = computeValuation(withTtm, ZERO_G);
  // dni: 400*a20/100 = 2x the FY-based figure
  expect(model(out, "dni20").value!).toBeCloseTo(2 * 17.027127439517116, 6);
});

test("negative base CF → null with note", () => {
  const bad = structuredClone(FIX);
  bad.years[0].operatingCashFlow = -50;
  const out = computeValuation(bad, ZERO_G);
  expect(model(out, "dcf20").value).toBeNull();
});

test("net debt exceeding PV → null, not negative price", () => {
  const bad = structuredClone(FIX);
  bad.years[0].totalDebt = 100000; // dwarfs any PV
  const out = computeValuation(bad, ZERO_G);
  expect(model(out, "dcf20").value).toBeNull();
  expect(model(out, "evEbitda").value).toBeNull();
  const vals = out.models.map((m) => m.value).filter((v): v is number => v !== null);
  expect(vals.every((v) => v > 0)).toBe(true);
});

test("composite never includes negative values", () => {
  const bad = structuredClone(FIX);
  bad.years[0].totalDebt = 100000;
  const out = computeValuation(bad, ZERO_G);
  if (out.composite !== null) expect(out.composite).toBeGreaterThan(0);
});

test("composite = trimmed mean of valid models, needs >= 5", () => {
  const out = computeValuation(FIX, ZERO_G);
  const vals = out.models.map((m) => m.value).filter((v): v is number => v !== null);
  expect(vals.length).toBeGreaterThanOrEqual(5);
  const sorted = [...vals].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  const expected = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  expect(out.composite!).toBeCloseTo(expected, 6);
  expect(out.range!.min).toBeCloseTo(sorted[0], 6);
  expect(out.range!.max).toBeCloseTo(sorted[sorted.length - 1], 6);
});

test("EV/Revenue and P/FCF use sector-median multiples when sector known", () => {
  const tech = structuredClone(FIX);
  tech.sector = "Technology";
  const out = computeValuation(tech, ZERO_G);
  // evRev: 5.5*1000 - debt 400 + cash 200 = 5300 → /100 shares = 53
  expect(model(out, "evRevenue").value!).toBeCloseTo(53, 6);
  expect(model(out, "evRevenue").variant).toBe("Sector multiple");
  // pFcf: 30 * 250 / 100 = 75
  expect(model(out, "pFcf").value!).toBeCloseTo(75, 6);
  expect(model(out, "pFcf").variant).toBe("Sector multiple");
  // evEbitda stays own-history even with a known sector
  expect(model(out, "evEbitda").variant).toBe("Own-history multiple");
});

test("unknown sector falls back to own-history multiples", () => {
  const out = computeValuation(FIX, ZERO_G); // FIX.sector = null
  expect(model(out, "evRevenue").variant).toBe("Own-history multiple");
});

test("industry-level multiple overrides sector-level (META-style calibration)", () => {
  const meta = structuredClone(FIX);
  meta.sector = "Communication Services"; // sector evRev = 3.0
  meta.industry = "Internet Content & Information"; // industry evRev = 5.3
  const out = computeValuation(meta, ZERO_G);
  // evRev: 5.3*1000 - debt 400 + cash 200 = 5100 → /100 shares = 51
  expect(model(out, "evRevenue").value!).toBeCloseTo(51, 6);
});

test("unknown industry falls back to sector-level multiple", () => {
  const vz = structuredClone(FIX);
  vz.sector = "Communication Services"; // sector evRev = 3.0
  vz.industry = "Some Unmapped Industry";
  const out = computeValuation(vz, ZERO_G);
  // evRev: 3.0*1000 - 400 + 200 = 2800 → /100 = 28
  expect(model(out, "evRevenue").value!).toBeCloseTo(28, 6);
});

test("industry entry missing a field falls through to that field's sector value", () => {
  const telco = structuredClone(FIX);
  telco.sector = "Communication Services"; // sector pFcf = 22
  telco.industry = "Telecom Services"; // industry defines evRev only, no pFcf
  const out = computeValuation(telco, ZERO_G);
  // pFcf falls back to sector's 22: 22*250/100 = 55
  expect(model(out, "pFcf").value!).toBeCloseTo(55, 6);
  // evRev uses the industry's own 3.0: 3.0*1000-400+200=2800 → /100 = 28
  expect(model(out, "evRevenue").value!).toBeCloseTo(28, 6);
});

test("both sector and industry null → own-history fallback (existing behavior)", () => {
  const out = computeValuation(FIX, ZERO_G); // FIX.sector = null, FIX.industry = null
  expect(model(out, "evRevenue").variant).toBe("Own-history multiple");
  expect(model(out, "pFcf").variant).toBe("Own-history multiple");
});

test("PEG uses 5Y net-income CAGR when growth knob untouched", () => {
  const out = computeValuation(FIX); // no overrides; fixture NI CAGR = 10%
  expect(model(out, "peg").value!).toBeCloseTo(20, 1); // EPS 2 × 10
});

test("PEG raw growth sanity-capped at 100", () => {
  const hyper = structuredClone(FIX);
  // 3x per year → NI CAGR 200% → capped at 100 → 2 × 100 = 200
  hyper.years = hyper.years.map((y, i) => ({
    ...y,
    revenue: 1000 * Math.pow(3, -i),
    netIncome: 200 * Math.pow(3, -i),
    operatingCashFlow: 300 * Math.pow(3, -i),
    freeCashFlow: 250 * Math.pow(3, -i),
  }));
  const out = computeValuation(hyper);
  expect(model(out, "peg").value!).toBeCloseTo(200, 1);
});

test("PEG respects a manual growth override (user's knob wins)", () => {
  const out = computeValuation(FIX, { normalGrowth: 0.05 });
  expect(model(out, "peg").value!).toBeCloseTo(10, 6); // EPS 2 × 5
});

test("H-model with assumed decline never emits a negative price", () => {
  const out = computeValuation(FIX, { ...ZERO_G, normalGrowth: -0.3 });
  expect(model(out, "hmodel").value).toBeNull();
  expect(model(out, "hmodel").note).toMatch(/decline/i);
  // No model in the output may be negative.
  const vals = out.models.map((m) => m.value).filter((v): v is number => v !== null);
  expect(vals.every((v) => v > 0)).toBe(true);
});

test("empty years → all 10 models n/a, composite/range null, assumptions resolved", () => {
  const empty = structuredClone(FIX);
  empty.years = [];
  let out!: ReturnType<typeof computeValuation>;
  expect(() => {
    out = computeValuation(empty);
  }).not.toThrow();
  expect(out.models).toHaveLength(10);
  for (const m of out.models) {
    expect(m.value, m.key).toBeNull();
    expect(m.note, m.key).toBe("n/a — no financial statements available");
  }
  // PEG in particular must be null (no history to justify growth), not the auto default.
  expect(model(out, "peg").value).toBeNull();
  expect(out.composite).toBeNull();
  expect(out.range).toBeNull();
  expect(out.assumptions).toBeDefined();
  expect(out.autoNormalGrowth).toBe(0.05); // rawGrowthMedian null → default
});

// --- textbook (no caps) variant --------------------------------------------

test("textbookPv: flat-perpetuity identity — g0=gT=0 → base/wacc exactly", () => {
  expect(textbookPv(100, 0, 0.1, 0)!).toBeCloseTo(1000, 6);
});

test("textbookPv: wacc <= gT → null", () => {
  expect(textbookPv(100, 0.1, 0.05, 0.06)).toBeNull();
  expect(textbookPv(100, 0.1, 0.05, 0.05)).toBeNull();
});

test("textbook variant carries a Gordon terminal value the calibrated three-stage engine omits: same base/g/wacc, textbook > calibrated", () => {
  const overrides = { normalGrowth: 0.06, terminalGrowth: 0.03, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const cal = computeValuation(FIX, overrides, "calibrated");
  const tb = computeValuation(FIX, overrides, "textbook");
  expect(model(tb, "dcf20").value!).toBeGreaterThan(model(cal, "dcf20").value!);
});

test("textbook auto WACC: pure CAPM, no cap — beta 3 → rf 0.04 + 3*0.055 = 0.205, not clamped to 0.12", () => {
  const hot = structuredClone(FIX);
  hot.beta = 3.0;
  const out = computeValuation(hot, {}, "textbook");
  expect(out.autoWacc).toBeCloseTo(0.205, 10);
});

test("textbook auto growth seed: uncapped — hyper-growth fixture seeds > 30%", () => {
  const hyper = structuredClone(FIX);
  hyper.years = hyper.years.map((y, i) => ({
    ...y,
    revenue: 1000 * Math.pow(3, -i),
    netIncome: 200 * Math.pow(3, -i),
    operatingCashFlow: 300 * Math.pow(3, -i),
    freeCashFlow: 250 * Math.pow(3, -i),
  }));
  const out = computeValuation(hyper, {}, "textbook");
  expect(out.autoNormalGrowth).toBeGreaterThan(0.3);
  // calibrated stays capped at 30% for the same fixture
  const calOut = computeValuation(hyper, {}, "calibrated");
  expect(calOut.autoNormalGrowth).toBeLessThanOrEqual(0.3);
});

test("FY vs TTM base: calibrated prefers ttm, textbook always uses latest fiscal year", () => {
  const withTtm = structuredClone(FIX);
  withTtm.ttm = { operatingCashFlow: 600, freeCashFlow: 500, netIncome: 400 };
  // g0 = gT = 0 so textbookPv collapses to the flat-perpetuity identity base/wacc.
  const ZERO_G_TB = { normalGrowth: 0, terminalGrowth: 0, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const cal = computeValuation(withTtm, ZERO_G, "calibrated");
  const tb = computeValuation(withTtm, ZERO_G_TB, "textbook");
  // calibrated: dni20 base = ttm.netIncome (400) → 2x the FY-based (200) figure
  expect(model(cal, "dni20").value!).toBeCloseTo(2 * 17.027127439517116, 6);
  // textbook: base = years[0].netIncome (200), NOT the ttm 400 — with zero
  // growth (g0=gT=0) textbookPv collapses to base/wacc exactly.
  expect(model(tb, "dni20").value!).toBeCloseTo(200 / 0.1 / 100, 6);
});

test("textbook multiples: own-history only even when sector is known", () => {
  const tech = structuredClone(FIX);
  tech.sector = "Technology";
  const out = computeValuation(tech, ZERO_G, "textbook");
  expect(model(out, "evRevenue").variant).toBe("Own-history multiple");
  expect(model(out, "pFcf").variant).toBe("Own-history multiple");
});

test("textbook PEG: no 100 sanity cap on hyper-growth NI CAGR", () => {
  const hyper = structuredClone(FIX);
  hyper.years = hyper.years.map((y, i) => ({
    ...y,
    revenue: 1000 * Math.pow(3, -i),
    netIncome: 200 * Math.pow(3, -i),
    operatingCashFlow: 300 * Math.pow(3, -i),
    freeCashFlow: 250 * Math.pow(3, -i),
  }));
  const out = computeValuation(hyper, {}, "textbook");
  // NI CAGR ≈ 200% (uncapped) → EPS 2 * 200 = 400, well above the calibrated
  // sanity cap's 200 ceiling.
  expect(model(out, "peg").value!).toBeGreaterThan(200);
});

test("textbook Graham: no 30 growth cap", () => {
  const hyper = structuredClone(FIX);
  hyper.years = hyper.years.map((y, i) => ({ ...y, revenue: 1000 * Math.pow(3, -i) }));
  const out = computeValuation(hyper, {}, "textbook");
  // autoNormalGrowth (revenue CAGR) ≈200%, uncapped in Graham's g too.
  const g100 = out.autoNormalGrowth * 100;
  expect(g100).toBeGreaterThan(30);
  const expected = (2 * (8.5 + 2 * g100) * 4.4) / 5.0;
  expect(model(out, "graham").value!).toBeCloseTo(expected, 4);
});

test("calibrated variant unaffected by textbook additions (regression)", () => {
  const out = computeValuation(FIX, ZERO_G, "calibrated");
  expect(model(out, "dcf20").value!).toBeCloseTo(23.540691159275674, 6);
});

// --- nextYear horizon -------------------------------------------------------

test("horizon defaults to 'current' when omitted (backward compatible)", () => {
  const withDefault = computeValuation(FIX, ZERO_G, "calibrated");
  const explicit = computeValuation(FIX, ZERO_G, "calibrated", "current");
  expect(withDefault.composite).toEqual(explicit.composite);
  expect(model(withDefault, "dcf20").value).toEqual(model(explicit, "dcf20").value);
});

test("textbook, zero growth everywhere (flat perpetuity): nextYear == current exactly for every model and the composite", () => {
  const out = computeValuation(FIX, ZERO_G, "textbook", "current");
  const outNext = computeValuation(FIX, ZERO_G, "textbook", "nextYear");
  for (const key of ["dcf20", "dfcf20", "dni20", "hmodel", "evEbitda", "evRevenue", "pFcf", "revDcf", "graham"]) {
    expect(model(outNext, key).value, key).toBeCloseTo(model(out, key).value!, 10);
  }
  expect(outNext.composite!).toBeCloseTo(out.composite!, 10);
});

test("multiples model (P/FCF): nextYear == current x (1 + seed growth) exactly", () => {
  const overrides = { normalGrowth: 0.2, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current");
  const nextYear = computeValuation(FIX, overrides, "calibrated", "nextYear");
  const curVal = model(current, "pFcf").value!;
  const nextVal = model(nextYear, "pFcf").value!;
  // P/FCF has no debt/cash offset (fair = mult * metric), so the (1+seed)
  // scaling on the metric passes straight through to the implied price.
  expect(nextVal).toBeCloseTo(curVal * 1.2, 10);
});

test("calibrated dcf20 nextYear: value accretes for a growing fixture, and the path-shift is exactly verifiable", () => {
  const overrides = { normalGrowth: 0.1, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current");
  const nextYear = computeValuation(FIX, overrides, "calibrated", "nextYear");
  expect(model(nextYear, "dcf20").value!).toBeGreaterThan(model(current, "dcf20").value!);

  // Manually reconstruct the engine's nextYear path-shift: dcf20's base is
  // FIX.years[0].operatingCashFlow (300, since FIX.ttm is null); the
  // three-stage path g=10% for 5y, 0.7*g for 5y, gT=4% for 10y is advanced
  // one year (drop year 1, append one more terminal year) and the base is
  // rebased by the OLD path's first-year rate — exactly what
  // valuation.ts's `advance`/discountedSeries do internally.
  const g = 0.1;
  const gT = 0.04;
  const wacc = 0.1;
  const oldPath = [
    g, g, g, g, g,
    0.7 * g, 0.7 * g, 0.7 * g, 0.7 * g, 0.7 * g,
    gT, gT, gT, gT, gT, gT, gT, gT, gT, gT,
  ];
  const shiftedPath = [...oldPath.slice(1), gT];
  const base1 = 300 * (1 + g);
  let cf = base1;
  let pv = 0;
  shiftedPath.forEach((gr, i) => {
    cf *= 1 + gr;
    pv += cf / Math.pow(1 + wacc, i + 1);
  });
  const equity = pv + (200 - 400); // FIX cash 200, debt 400, dcf20 adjusts net debt
  const expected = equity / 100; // FIX sharesOutstanding = 100
  expect(model(nextYear, "dcf20").value!).toBeCloseTo(expected, 6);
});

test("composite recomputed per horizon: nextYear composite exceeds current for a growing fixture", () => {
  const overrides = { normalGrowth: 0.1, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current");
  const nextYear = computeValuation(FIX, overrides, "calibrated", "nextYear");
  expect(current.composite).not.toBeNull();
  expect(nextYear.composite).not.toBeNull();
  expect(nextYear.composite!).toBeGreaterThan(current.composite!);
});

test("existing current-horizon tests are unaffected (regression, ZERO_G calibrated)", () => {
  const out = computeValuation(FIX, ZERO_G, "calibrated", "current");
  expect(model(out, "dcf20").value!).toBeCloseTo(23.540691159275674, 6);
  expect(model(out, "hmodel").value!).toBeCloseTo(25, 6);
});

// --- quarterly horizons (q1/q2) ----------------------------------------------
// Geometric interpolation between the current/nextYear endpoints:
// V(q) = Vcurrent * (Vnext/Vcurrent)^f, f = 0.25 (q1) or 0.5 (q2).

test("q1 P/FCF == current x (1 + seed growth)^0.25 exactly", () => {
  const overrides = { normalGrowth: 0.2, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current");
  const q1 = computeValuation(FIX, overrides, "calibrated", "q1");
  const curVal = model(current, "pFcf").value!;
  const q1Val = model(q1, "pFcf").value!;
  // P/FCF's nextYear == current * 1.2 exactly (see the existing nextYear test
  // above), so q1's geometric interpolation reduces to current * 1.2^0.25.
  expect(q1Val).toBeCloseTo(curVal * Math.pow(1.2, 0.25), 10);
});

test("q2 of dcf20 == geometric mean of current and nextYear", () => {
  const overrides = { normalGrowth: 0.1, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current");
  const nextYear = computeValuation(FIX, overrides, "calibrated", "nextYear");
  const q2 = computeValuation(FIX, overrides, "calibrated", "q2");
  const curVal = model(current, "dcf20").value!;
  const nextVal = model(nextYear, "dcf20").value!;
  const q2Val = model(q2, "dcf20").value!;
  expect(q2Val).toBeCloseTo(Math.sqrt(curVal * nextVal), 6);
});

test("monotonic for a growing fixture: current < q1 < q2 < nextYear (composite)", () => {
  const overrides = { normalGrowth: 0.1, terminalGrowth: 0.04, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current").composite!;
  const q1 = computeValuation(FIX, overrides, "calibrated", "q1").composite!;
  const q2 = computeValuation(FIX, overrides, "calibrated", "q2").composite!;
  const nextYear = computeValuation(FIX, overrides, "calibrated", "nextYear").composite!;
  expect(current).not.toBeNull();
  expect(current).toBeLessThan(q1);
  expect(q1).toBeLessThan(q2);
  expect(q2).toBeLessThan(nextYear);
});

test("null endpoint => null quarterly value (wacc=0 nulls the DCF family at both endpoints)", () => {
  const overrides = { normalGrowth: 0.1, terminalGrowth: 0.04, wacc: 0, marginExpansion: 0, hHalfLife: 4 };
  const current = computeValuation(FIX, overrides, "calibrated", "current");
  const nextYear = computeValuation(FIX, overrides, "calibrated", "nextYear");
  expect(model(current, "dcf20").value).toBeNull();
  expect(model(nextYear, "dcf20").value).toBeNull();
  const q1 = computeValuation(FIX, overrides, "calibrated", "q1");
  const q2 = computeValuation(FIX, overrides, "calibrated", "q2");
  expect(model(q1, "dcf20").value).toBeNull();
  expect(model(q2, "dcf20").value).toBeNull();
});

// Task 38 part A: q1/q2 must be built off the SAME variant's own current/
// nextYear endpoints — a textbook q1/q2 must never accidentally interpolate
// calibrated's endpoints (e.g. from a shared/miswired cache or default-arg
// bug). Textbook's own terminal-growth default (2.5%) and linear-fade shape
// differ from calibrated's (4%, three-stage) even with identical auto
// growth/WACC on this fixture, so the two variants' dcf20 current values are
// provably different — a strong enough signal to catch cross-variant mixups.
test("textbook q1/q2 interpolate between TEXTBOOK's own endpoints, not calibrated's", () => {
  const tbCurrent = computeValuation(FIX, {}, "textbook", "current");
  const tbNext = computeValuation(FIX, {}, "textbook", "nextYear");
  const tbQ1 = computeValuation(FIX, {}, "textbook", "q1");
  const tbQ2 = computeValuation(FIX, {}, "textbook", "q2");
  const calCurrent = computeValuation(FIX, {}, "calibrated", "current");

  const tbCur = model(tbCurrent, "dcf20").value!;
  const tbNextVal = model(tbNext, "dcf20").value!;
  const tbQ1Val = model(tbQ1, "dcf20").value!;
  const tbQ2Val = model(tbQ2, "dcf20").value!;
  const calCur = model(calCurrent, "dcf20").value!;

  // Sanity: calibrated and textbook actually diverge on this fixture (2.5%
  // vs 4% terminal default + linear-fade vs three-stage shape) — otherwise
  // this test couldn't distinguish "textbook's own endpoints" from
  // "calibrated's endpoints" at all.
  expect(Math.abs(tbCur - calCur)).toBeGreaterThan(0.01);

  expect(tbQ1Val).toBeCloseTo(tbCur * Math.pow(tbNextVal / tbCur, 0.25), 6);
  expect(tbQ2Val).toBeCloseTo(tbCur * Math.pow(tbNextVal / tbCur, 0.5), 6);

  // And explicitly NOT calibrated's interpolation (would only coincidentally
  // match if tbCur/tbNextVal happened to equal calibrated's, which the
  // divergence check above already rules out).
  const calNext = computeValuation(FIX, {}, "calibrated", "nextYear");
  const calNextVal = model(calNext, "dcf20").value!;
  const wrongQ1 = calCur * Math.pow(calNextVal / calCur, 0.25);
  expect(tbQ1Val).not.toBeCloseTo(wrongQ1, 2);
});
