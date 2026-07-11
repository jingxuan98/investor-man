import { expect, test } from "vitest";
import { computeQuality, toGrade } from "@/lib/finance/grading";
import { FIX } from "./fixture";

test("grade boundaries", () => {
  expect(toGrade(95)).toBe("A");
  expect(toGrade(90)).toBe("A");
  expect(toGrade(85)).toBe("B+");
  expect(toGrade(75)).toBe("B");
  expect(toGrade(65)).toBe("C+");
  expect(toGrade(55)).toBe("C");
  expect(toGrade(40)).toBe("D");
  expect(toGrade(10)).toBe("F");
});

test("fixture profitability score is high (margins 20%/28%, ROE 20%, ROIC>15%)", () => {
  const q = computeQuality(FIX, 40);
  const p = q.dimensions.find((d) => d.key === "profitability")!;
  // netMargin 20% → 100; opMargin 28% → 100; ROE 200/1000=20% → 100;
  // ROIC = 280*0.79/(1000+400-200) = 221.2/1200 = 18.4% → 100. All 100.
  expect(p.score!).toBeGreaterThan(95);
});

test("valuation dimension: fair value == price → ~50", () => {
  const q = computeQuality(FIX, 40); // upside 0 → upside score 50
  const v = q.dimensions.find((d) => d.key === "valuation")!;
  expect(v.score!).toBeGreaterThan(30);
  expect(v.score!).toBeLessThan(70);
});

test("all six dimensions present and overall computed", () => {
  const q = computeQuality(FIX, 50);
  expect(q.dimensions.map((d) => d.key).sort()).toEqual(
    ["finStrength", "growth", "moat", "predictability", "profitability", "valuation"].sort()
  );
  expect(q.overallScore).not.toBeNull();
  expect(q.overallGrade).not.toBeNull();
});

test("growth dimension: flat (0% CAGR) company scores the 30-point floor, not 0", () => {
  const flat = structuredClone(FIX);
  // make every year identical → all CAGRs exactly 0
  flat.years = flat.years.map((y) => ({ ...FIX.years[0], year: y.year }));
  const q = computeQuality(flat, 40);
  const g = q.dimensions.find((d) => d.key === "growth")!;
  // subs all 30, no bonus (epsC 0 >= revC 0 → +10), so 40; assert in [30, 50]
  expect(g.score!).toBeGreaterThanOrEqual(30);
  expect(g.score!).toBeLessThanOrEqual(50);
});

test("null composite → valuation dimension null, overall still computed from rest", () => {
  const q = computeQuality(FIX, null);
  const v = q.dimensions.find((d) => d.key === "valuation")!;
  expect(v.score).toBeNull();
  expect(q.overallScore).not.toBeNull();
});

test("empty years → all 6 dimensions null, overall null, no throw", () => {
  const empty = structuredClone(FIX);
  empty.years = [];
  let q!: ReturnType<typeof computeQuality>;
  expect(() => {
    q = computeQuality(empty, 40);
  }).not.toThrow();
  expect(q.dimensions).toHaveLength(6);
  for (const d of q.dimensions) {
    expect(d.score, d.key).toBeNull();
    expect(d.grade, d.key).toBeNull();
    expect(d.detail, d.key).toBe("n/a — no financial statements available");
  }
  expect(q.overallScore).toBeNull();
  expect(q.overallGrade).toBeNull();
});
