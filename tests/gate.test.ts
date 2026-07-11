import { expect, test } from "vitest";
import {
  computeGate,
  scoreRoicVsWacc,
  scoreGrossMargin,
  scoreRevenueQuality,
  scoreCapitalAllocation,
} from "@/lib/finance/gate";
import { FIX } from "./fixture";

// Acceptance evidence: the controller extracted 9 real samples per factor from
// the reference site (readings → their actual scores). Kernels must reproduce.

test("Q-01 scoreRoicVsWacc — exact fit, 9/9", () => {
  const table: [number, "widening" | "compressing" | "stable", number][] = [
    [-462, "widening", 0],
    [-1267, "compressing", 0],
    [-184, "widening", 7],
    [-359, "compressing", 0],
    [-242, "stable", 0],
    [25, "compressing", 8],
    [190, "stable", 10],
    [42, "stable", 10],
    [1014, "widening", 25],
  ];
  for (const [spread, trend, expected] of table) {
    expect(scoreRoicVsWacc(spread, trend), `spread=${spread} trend=${trend}`).toBe(expected);
  }
});

test("Q-02 scoreGrossMargin — approximate fit, |ours−theirs| ≤ 2", () => {
  const table: [number, number, number][] = [
    [325, 75.7, 25],
    [285, 49.5, 23],
    [665, 50.3, 25],
    [21, 12.8, 12],
    [141, 30.4, 15],
    [-603, 31.6, 7],
    [-396, 18.5, 4],
    [582, 59.4, 25],
    [111, 45.6, 18],
  ];
  for (const [changeBps, gmPct, expected] of table) {
    const ours = scoreGrossMargin(changeBps, gmPct);
    expect(
      Math.abs(ours - expected),
      `changeBps=${changeBps} gm=${gmPct}: ours=${ours} theirs=${expected}`
    ).toBeLessThanOrEqual(2);
  }
});

test("Q-03 scoreRevenueQuality — exact fit, 9/9", () => {
  const table: [number, number, number, number][] = [
    [4, 4, 16.8, 23],
    [3, 4, 20.5, 16],
    [4, 4, 11.1, 23],
    [4, 4, 8.9, 21],
    [1, 4, 4.3, 4],
    [4, 4, 7.0, 21],
    [4, 4, 11.7, 23],
    [3, 4, 3.0, 11],
    [3, 4, 0.8, 11],
  ];
  for (const [pos, denom, cagr, expected] of table) {
    expect(scoreRevenueQuality(pos, denom, cagr), `pos=${pos}/${denom} cagr=${cagr}`).toBe(
      expected
    );
  }
});

test("Q-04 scoreCapitalAllocation — exact fit, 9/9", () => {
  const table: [number, number, number, number][] = [
    [5, 5, 8.0, 16],
    [5, 5, 0.1, 12],
    [3, 5, 0.0, 8],
    [5, 5, 0.2, 12],
    [5, 5, 3.4, 16],
    [1, 5, 0.0, 5],
    [5, 5, 1.4, 16],
    [5, 5, 1.6, 16],
    [5, 5, 0.0, 12],
  ];
  for (const [pos, denom, yield_, expected] of table) {
    expect(
      scoreCapitalAllocation(pos, denom, yield_),
      `pos=${pos}/${denom} buyback=${yield_}`
    ).toBe(expected);
  }
});

test("computeGate(FIX) — 4 factors, no throw, coherent grade", () => {
  const g = computeGate(FIX);
  expect(g.factors).toHaveLength(4);
  expect(g.factors.map((f) => f.key)).toEqual([
    "roicVsWacc",
    "grossMarginTrend",
    "revenueQuality",
    "capitalAllocation",
  ]);
  // score is the sum of factor scores; grade/pass are coherent with it.
  expect(g.score).toBe(g.factors.reduce((a, f) => a + f.score, 0));
  expect(g.score).toBeGreaterThanOrEqual(0);
  expect(g.score).toBeLessThanOrEqual(100);
  expect(g.passed).toBe(g.score >= 60);
  expect(["A", "B", "C", "D", "F"]).toContain(g.grade);
  for (const f of g.factors) {
    expect(f.score).toBeGreaterThanOrEqual(0);
    expect(f.score).toBeLessThanOrEqual(25);
    expect(Number.isNaN(f.score)).toBe(false);
  }
});

test("computeGate — empty years clone → all zeros, grade F, failed", () => {
  const empty = { ...FIX, years: [] };
  const g = computeGate(empty);
  expect(g.factors).toHaveLength(4);
  expect(g.factors.every((f) => f.score === 0)).toBe(true);
  expect(g.score).toBe(0);
  expect(g.grade).toBe("F");
  expect(g.passed).toBe(false);
  expect(g.factors.every((f) => f.status === "n/a — no financial statements available")).toBe(
    true
  );
});
