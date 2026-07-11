import { expect, test } from "vitest";
import { buildStory } from "@/lib/finance/story";
import { reverseDcf } from "@/lib/finance/insights";
import { computeValuation } from "@/lib/finance/valuation";
import { computeQuality } from "@/lib/finance/grading";
import { computeGate } from "@/lib/finance/gate";
import { StockBundle } from "@/lib/data/getStockData";
import { FIX } from "./fixture";
import { FinancialSnapshot } from "@/lib/finance/types";

function bundleOf(s: FinancialSnapshot): StockBundle {
  const valuation = computeValuation(s);
  const quality = computeQuality(s, valuation.composite);
  const gate = computeGate(s);
  return { snapshot: s, valuation, quality, gate };
}

test("FIX: composite is non-null (sanity for the tests below)", () => {
  const b = bundleOf(FIX);
  expect(b.valuation.composite).not.toBeNull();
});

test("zones: exactly one active zone, and ranges are in ascending order", () => {
  const b = bundleOf(FIX);
  const story = buildStory(b, reverseDcf(FIX));
  expect(story.zones).not.toBeNull();
  const zones = story.zones!;
  expect(zones).toHaveLength(5);
  const activeCount = zones.filter((z) => z.active).length;
  expect(activeCount).toBe(1);
  // Fixed label ordering: full conviction -> accumulate -> hold -> patience -> trim
  expect(zones.map((z) => z.label.split(" —")[0])).toEqual([
    "Full conviction",
    "Accumulate",
    "Hold, don't add",
    "Patience",
    "Trim into strength",
  ]);
});

test("zones: price below every method's implied value activates 'full conviction'", () => {
  const s = structuredClone(FIX);
  s.price = 0.01; // absurdly cheap vs any model's implied value
  s.marketCap = s.price * s.sharesOutstanding;
  const b = bundleOf(s);
  const story = buildStory(b, reverseDcf(s));
  expect(story.zones).not.toBeNull();
  expect(story.zones![0].active).toBe(true);
  expect(story.zones!.filter((z) => z.active)).toHaveLength(1);
});

test("zones: price above every method's implied value activates 'trim'", () => {
  const s = structuredClone(FIX);
  s.price = 100000;
  s.marketCap = s.price * s.sharesOutstanding;
  const b = bundleOf(s);
  const story = buildStory(b, reverseDcf(s));
  expect(story.zones).not.toBeNull();
  expect(story.zones![4].active).toBe(true);
  expect(story.zones!.filter((z) => z.active)).toHaveLength(1);
});

test("kill criteria: ROIC <= WACC is breached when returns collapse", () => {
  const s = structuredClone(FIX);
  // Crush operating income across the board so ROIC << WACC.
  for (const y of s.years) y.operatingIncome = 1;
  const b = bundleOf(s);
  const story = buildStory(b, reverseDcf(s));
  const kc1 = story.killCriteria[0];
  expect(kc1.title).toMatch(/Returns spread collapses/);
  expect(kc1.breached).toBe(true);
});

test("kill criteria: ROIC comfortably above WACC is dormant", () => {
  const b = bundleOf(FIX);
  const story = buildStory(b, reverseDcf(FIX));
  // FIX's fixture is a healthy, profitable company — spread should be positive.
  expect(story.killCriteria[0].breached).toBe(false);
});

test("kill criteria: operating margin collapse vs 5Y average is breached", () => {
  const s = structuredClone(FIX);
  // Oldest 3 years keep their healthy margin; make the latest year's margin
  // less than half of the 5Y average by crushing only years[0].
  s.years[0].operatingIncome = (s.years[0].revenue as number) * 0.01;
  const b = bundleOf(s);
  const story = buildStory(b, reverseDcf(s));
  const kc3 = story.killCriteria[2];
  expect(kc3.title).toMatch(/margin base erodes/);
  expect(kc3.breached).toBe(true);
});

test("kill criteria: price outside the bear-bull range is breached", () => {
  const b = bundleOf(FIX);
  const story = buildStory(b, reverseDcf(FIX));
  expect(story.bearBaseBull).not.toBeNull();
  const bull = story.bearBaseBull!.find((x) => x.label === "BULL")!;

  const s = structuredClone(FIX);
  s.price = bull.value * 10; // force price far outside the surviving range
  s.marketCap = s.price * s.sharesOutstanding;
  const b2 = bundleOf(s);
  const story2 = buildStory(b2, reverseDcf(s));
  expect(story2.killCriteria[3].breached).toBe(true);
});

test("null-composite path (empty years) never throws and degrades gracefully", () => {
  const s = structuredClone(FIX);
  s.years = [];
  const b = bundleOf(s);
  expect(b.valuation.composite).toBeNull();

  let story: ReturnType<typeof buildStory> | undefined;
  expect(() => {
    story = buildStory(b, reverseDcf(s));
  }).not.toThrow();

  expect(story!.bearBaseBull).toBeNull();
  expect(story!.zones).toBeNull();
  // The answer must still be a non-empty, well-formed sentence.
  expect(story!.answer.length).toBeGreaterThan(0);
  expect(story!.answer).toContain("Test Corp");
  expect(story!.answer.trim().endsWith(".")).toBe(true);
  // Kill criteria and risks are always present (4 and 3 respectively), even
  // when every reading degrades to "n/a".
  expect(story!.killCriteria).toHaveLength(4);
  expect(story!.risks).toHaveLength(3);
  for (const kc of story!.killCriteria) expect(kc.breached).toBe(false);
});

test("thesis always has exactly 3 items and risks always has exactly 3 items", () => {
  const b = bundleOf(FIX);
  const story = buildStory(b, reverseDcf(FIX));
  expect(story.thesis).toHaveLength(3);
  expect(story.risks).toHaveLength(3);
});
