import { expect, test } from "vitest";
import { buildPrompt, isReportType } from "@/lib/ai/prompts";
import { computeValuation } from "@/lib/finance/valuation";
import { computeQuality } from "@/lib/finance/grading";
import { computeGate } from "@/lib/finance/gate";
import { StockBundle } from "@/lib/data/getStockData";
import { FIX } from "./fixture";

function bundle(): StockBundle {
  const valuation = computeValuation(FIX);
  const quality = computeQuality(FIX, valuation.composite);
  const gate = computeGate(FIX);
  return { snapshot: FIX, valuation, quality, gate };
}

test("isReportType guards the eight valid types", () => {
  expect(isReportType("research")).toBe(true);
  expect(isReportType("model3")).toBe(true);
  expect(isReportType("bear")).toBe(true);
  expect(isReportType("bull")).toBe(true);
  expect(isReportType("risks")).toBe(true);
  expect(isReportType("deepdive")).toBe(true);
  expect(isReportType("story")).toBe(true);
  expect(isReportType("playbook")).toBe(true);
  expect(isReportType("summary")).toBe(false);
  expect(isReportType(42)).toBe(false);
  expect(isReportType(undefined)).toBe(false);
});

test("every prompt embeds the verified data block and markdown instruction", () => {
  for (const type of [
    "research",
    "model3",
    "bear",
    "bull",
    "risks",
    "deepdive",
    "story",
    "playbook",
  ] as const) {
    const { prompt } = buildPrompt(type, bundle());
    // data block: name, ticker, and a historical revenue figure present
    expect(prompt).toContain("VERIFIED FINANCIAL DATA for Test Corp (TEST)");
    expect(prompt).toContain("do NOT invent different historical figures");
    // markdown formatting instruction appended
    expect(prompt).toContain("Format the entire response as clean Markdown");
  }
});

test("grounding flags per type", () => {
  expect(buildPrompt("research", bundle()).grounding).toBe(true);
  expect(buildPrompt("bear", bundle()).grounding).toBe(true);
  expect(buildPrompt("bull", bundle()).grounding).toBe(true);
  expect(buildPrompt("risks", bundle()).grounding).toBe(true);
  expect(buildPrompt("model3", bundle()).grounding).toBe(false);
  expect(buildPrompt("deepdive", bundle()).grounding).toBe(false);
  // story grounds: BLOCK 2B asks for current market narratives
  expect(buildPrompt("story", bundle()).grounding).toBe(true);
  // playbook grounds: catalyst calendar + market narrative both need search
  expect(buildPrompt("playbook", bundle()).grounding).toBe(true);
});

test("bull prompt injects the live price like bear does", () => {
  const b = bundle();
  const bull = buildPrompt("bull", b).prompt;
  expect(bull).toContain("bull case on Test Corp (TEST) at 40");
  expect(bull).toContain("% upside from 40");
});

test("deepdive prompt embeds a methods table with a known FIX model", () => {
  const b = bundle();
  const deepdive = buildPrompt("deepdive", b).prompt;
  expect(deepdive).toContain("OUR 10 VALUATION METHODS");
  // DCF-20 is always present in ValuationOutput.models regardless of value
  expect(deepdive).toMatch(/DCF-20: -?\d/);
});

test("risks prompt ranks risks with severity and a metric to watch", () => {
  const risks = buildPrompt("risks", bundle()).prompt;
  expect(risks).toContain("RANK");
  expect(risks).toContain("Severity");
  expect(risks).toContain("Metric to watch");
});

test("research prompt grounds in Damodaran story/numbers + Fisher + Porter + Mauboussin base-rate + Marks", () => {
  const research = buildPrompt("research", bundle()).prompt;
  expect(research).toContain("THE STORY");
  expect(research).toContain("FISHER QUALITY SCREEN");
  expect(research).toContain("COMPETITIVE POSITION (Porter)");
  expect(research).toContain("BASE-RATE");
  expect(research).toContain("SECOND-LEVEL VIEW");
});

test("bear prompt is framed as a Munger pre-mortem", () => {
  const bear = buildPrompt("bear", bundle()).prompt;
  expect(bear).toMatch(/PRE-MORTEM|post-mortem/);
  expect(bear).toContain("THE TRIPWIRE");
});

test("bull prompt is framed as variant perception", () => {
  const bull = buildPrompt("bull", bundle()).prompt;
  expect(bull).toContain("VARIANT");
});

test("risks prompt defines risk as permanent capital loss and adds the Munger incentive angle", () => {
  const risks = buildPrompt("risks", bundle()).prompt;
  expect(risks).toContain("permanent capital loss");
  expect(risks).toContain("Incentive angle");
});

test("deepdive prompt runs the Expectations Investing (Mauboussin/Rappaport) treatment", () => {
  const deepdive = buildPrompt("deepdive", bundle()).prompt;
  expect(deepdive).toContain("PRICE-IMPLIED EXPECTATIONS");
  expect(deepdive).toContain("BASE-RATE TEST");
});

test("model3 prompt adds a base-rate sanity check and probability-weighted scenarios", () => {
  const model3 = buildPrompt("model3", bundle()).prompt;
  expect(model3).toContain("BASE-RATE SANITY CHECK");
  expect(model3).toContain("probability weight");
  expect(model3).toContain("probability-weighted intrinsic value");
});

test("story prompt embeds the machine-drafted blocks and a rewrite instruction, no invented numbers", () => {
  const story = buildPrompt("story", bundle()).prompt;
  expect(story).toContain("VERIFIED FINANCIAL DATA for Test Corp (TEST)");
  expect(story).toContain("BLOCK 1 — THE ANSWER");
  expect(story).toContain("BLOCK 2 — THE NARRATIVE");
  expect(story).toContain("BLOCK 3 — THE THESIS, NUMBERED");
  expect(story).toContain("BLOCK 2B — MARKET NARRATIVES");
  expect(story).toContain("bull narrative");
  expect(story).toContain("bear narrative");
  expect(story).toContain("do not invent");
  expect(story).toContain("Format the entire response as clean Markdown");
});

test("bear case injects the live price, model3 cites Yahoo, no hardcoded refs", () => {
  const b = bundle();
  const bear = buildPrompt("bear", b).prompt;
  // live price (40) injected where the original prompt hardcoded 75
  expect(bear).toContain("bear case on Test Corp (TEST) at 40");
  expect(bear).toContain("% downside from 40");
  // no leftover source-company references
  for (const p of ["research", "model3", "bear", "bull", "risks", "deepdive", "playbook"] as const) {
    const txt = buildPrompt(p, b).prompt;
    expect(txt).not.toMatch(/reddit|RDDT|Apple|AAPL/i);
  }
  const model3 = buildPrompt("model3", b).prompt;
  expect(model3).toContain("company filings via Yahoo Finance");
  expect(model3).not.toContain("SEC");
});

test("playbook prompt has all four sections, injects the live price, and anchors targets to our methods", () => {
  const b = bundle();
  const playbook = buildPrompt("playbook", b).prompt;
  expect(playbook).toContain("## CATALYST CALENDAR");
  expect(playbook).toContain("## SCENARIO ANALYSIS");
  expect(playbook).toContain("## KEY RISKS");
  expect(playbook).toContain("## MARKET NARRATIVE");
  // live price injected (FIX price is 40, per the bear/bull tests above)
  expect(playbook).toContain("Playbook\" for Test Corp (TEST) at 40");
  expect(playbook).toContain("show the math from 40 to the target");
  // anchored to OUR methods table, not an invented multiple
  expect(playbook).toContain("OUR 10 VALUATION METHODS");
  expect(playbook).toMatch(/DCF-20: -?\d/);
  expect(playbook).toContain("do NOT invent a new multiple");
  // probabilities must sum to 100%, bear/bull framed as genuine/achievable
  expect(playbook).toContain("must sum to 100%");
  expect(playbook).toContain("genuine downside risk");
  expect(playbook).toContain("achievable, not fantasy");
  // risks section reuses Marks's permanent-capital-loss framing, shortened
  expect(playbook).toContain("permanent capital loss");
  expect(playbook).toContain("Watch metric");
  // market narrative covers bull/bear + the unwind path
  expect(playbook).toContain("bulls have been saying recently");
  expect(playbook).toContain("bears have been saying recently");
  expect(playbook).toContain("If the thesis breaks");
});
