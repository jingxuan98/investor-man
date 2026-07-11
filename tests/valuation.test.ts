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
