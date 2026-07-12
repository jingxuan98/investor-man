import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { geminiJSON, modelChain, parseCompetitors } from "@/lib/ai/gemini";

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

// geminiJSON: a real bug found while investigating prod "competitors
// unavailable" reports — a model occasionally returns truncated/malformed
// JSON despite responseMimeType being set, and the old code let JSON.parse's
// exception escape uncaught, skipping every remaining fallback model in the
// chain entirely instead of trying the next one.
function fakeGeminiResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as unknown as Response;
}

test("geminiJSON: malformed JSON from one model falls through to the next", async () => {
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  process.env.GEMINI_FALLBACK_MODELS = "gemini-3.1-flash-lite";
  const fetchMock = vi
    .fn()
    // First model: truncated JSON (missing closing bracket).
    .mockResolvedValueOnce(fakeGeminiResponse('[{"ticker": "MSFT", "name": "Microsoft"'))
    // Second model: valid JSON.
    .mockResolvedValueOnce(
      fakeGeminiResponse(JSON.stringify([{ ticker: "MSFT", name: "Microsoft" }]))
    );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const result = await geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    expect(result).toEqual([{ ticker: "MSFT", name: "Microsoft" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("geminiJSON: malformed JSON from every model in the chain throws GEMINI_PARSE_ERROR", async () => {
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  process.env.GEMINI_FALLBACK_MODELS = "gemini-3.1-flash-lite";
  const fetchMock = vi.fn().mockResolvedValue(fakeGeminiResponse("not json at all"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(geminiJSON("prompt", "fake-key")).rejects.toThrow("GEMINI_PARSE_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
