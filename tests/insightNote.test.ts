import { expect, test } from "vitest";
import { buildAnalystNote } from "@/lib/finance/insightNote";
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

test("FIX bundle: exactly 3 paragraphs, including a fair-value sentence with real numbers", () => {
  const b = bundleOf(FIX);
  expect(b.valuation.composite).not.toBeNull();
  const note = buildAnalystNote(b);
  expect(note).toHaveLength(3);

  const fvSentence = note[2];
  expect(fvSentence).toMatch(/fair-value estimate prints/);
  // Real dollar figures, not placeholders.
  expect(fvSentence).toMatch(/\$[\d,]+\.\d{2}/);
  const dollarMatches = fvSentence.match(/\$[\d,]+\.\d{2}/g) ?? [];
  expect(dollarMatches.length).toBeGreaterThanOrEqual(2);
  expect(fvSentence).toMatch(/%/);
  expect(fvSentence).not.toMatch(/null|NaN/);
});

test("FIX bundle: paragraph 1 names the top dimensions and paragraph 2 the weakest", () => {
  const b = bundleOf(FIX);
  const note = buildAnalystNote(b);
  expect(note[0]).toMatch(/The case for owning TEST/);
  expect(note[1]).toMatch(/The case against adding today is/);
});

test("degenerate bundle (empty years) never throws, note is shorter, no null/NaN text", () => {
  const s = structuredClone(FIX);
  s.years = [];
  const b = bundleOf(s);
  expect(b.valuation.composite).toBeNull();

  let note: string[] | undefined;
  expect(() => {
    note = buildAnalystNote(b);
  }).not.toThrow();

  expect(note).toBeDefined();
  expect(note!.length).toBeLessThan(3);
  for (const p of note!) {
    expect(p).not.toMatch(/null/i);
    expect(p).not.toMatch(/NaN/);
  }
});

test("degenerate bundle (null composite, dimensions present) skips only the valuation paragraph", () => {
  const b = bundleOf(FIX);
  // Force a null composite while keeping the other 5 dimensions intact.
  const bNullComposite: StockBundle = {
    ...b,
    valuation: { ...b.valuation, composite: null },
    quality: computeQuality(FIX, null),
  };
  const note = buildAnalystNote(bNullComposite);
  expect(note.length).toBe(2);
  for (const p of note) {
    expect(p).not.toMatch(/null/i);
    expect(p).not.toMatch(/NaN/);
  }
});
