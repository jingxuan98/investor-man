import { afterEach, beforeEach, expect, test } from "vitest";
import { modelChain, parseCompetitors } from "@/lib/ai/gemini";

test("parseCompetitors validates, uppercases, dedupes, caps at 5", () => {
  const raw = [
    { ticker: "msft", name: "Microsoft" },
    { ticker: "GOOGL", name: "Alphabet" },
    { ticker: "MSFT", name: "Microsoft dup" },
    { ticker: "", name: "bad" },
    { name: "no ticker" },
    { ticker: "AMZN", name: "Amazon" },
    { ticker: "META", name: "Meta" },
    { ticker: "NVDA", name: "Nvidia" },
    { ticker: "ORCL", name: "Oracle" },
  ];
  const out = parseCompetitors(raw);
  expect(out).toHaveLength(5);
  expect(out[0]).toEqual({ ticker: "MSFT", name: "Microsoft" });
  expect(out.map((c) => c.ticker)).toEqual(["MSFT", "GOOGL", "AMZN", "META", "NVDA"]);
});

test("parseCompetitors handles garbage", () => {
  expect(parseCompetitors(null)).toEqual([]);
  expect(parseCompetitors("nonsense")).toEqual([]);
});

// modelChain reads process.env, so snapshot and restore the two vars it uses
// around each case to keep tests order-independent.
let savedModel: string | undefined;
let savedFallbacks: string | undefined;

beforeEach(() => {
  savedModel = process.env.GEMINI_MODEL;
  savedFallbacks = process.env.GEMINI_FALLBACK_MODELS;
});

afterEach(() => {
  if (savedModel === undefined) delete process.env.GEMINI_MODEL;
  else process.env.GEMINI_MODEL = savedModel;
  if (savedFallbacks === undefined) delete process.env.GEMINI_FALLBACK_MODELS;
  else process.env.GEMINI_FALLBACK_MODELS = savedFallbacks;
});

test("modelChain: primary leads, fallbacks follow in order", () => {
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  process.env.GEMINI_FALLBACK_MODELS = "gemini-3.1-flash-lite,gemma-4-31b-it";
  expect(modelChain()).toEqual([
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemma-4-31b-it",
  ]);
});

test("modelChain: defaults apply when env vars are unset", () => {
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODELS;
  expect(modelChain()).toEqual([
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemma-4-31b-it",
  ]);
});

test("modelChain: trims whitespace and drops empty entries", () => {
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  process.env.GEMINI_FALLBACK_MODELS = " gemini-3.1-flash-lite , , gemma-4-31b-it ,";
  expect(modelChain()).toEqual([
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemma-4-31b-it",
  ]);
});

test("modelChain: an empty fallback list yields just the primary", () => {
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  process.env.GEMINI_FALLBACK_MODELS = "";
  expect(modelChain()).toEqual(["gemini-3.5-flash"]);
});
