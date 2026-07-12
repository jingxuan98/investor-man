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

// --- Patient retry/backoff (free-tier rate-limit pacing) -------------------
// A 429 response shaped like Gemini's real error body, carrying a RetryInfo
// detail so parseRetryDelayMs has something to extract.
function rateLimitedResponse(retryDelay: string): Response {
  const bodyText = JSON.stringify({
    error: {
      details: [
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
      ],
    },
  });
  return {
    ok: false,
    status: 429,
    headers: { get: () => null },
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  } as unknown as Response;
}

function serverErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({}),
  } as unknown as Response;
}

test("geminiJSON: 429 with a RetryInfo delay retries the SAME model after waiting, then succeeds", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  process.env.GEMINI_FALLBACK_MODELS = "gemini-3.1-flash-lite";
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(rateLimitedResponse("3s"))
    .mockResolvedValueOnce(
      fakeGeminiResponse(JSON.stringify([{ ticker: "MSFT", name: "Microsoft" }]))
    );
  vi.stubGlobal("fetch", fetchMock);
  try {
    const promise = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result).toEqual([{ ticker: "MSFT", name: "Microsoft" }]);
    // Both calls hit the SAME (primary) model — no fallback needed.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("gemini-3.5-flash");
    expect(urls[1]).toContain("gemini-3.5-flash");
    expect(urls.some((u) => u.includes("gemini-3.1-flash-lite"))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("geminiJSON: chain order preserved across fallbacks under the new retry pacing (500/503 + a 2s inter-model gap)", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2,m3";
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(serverErrorResponse(500)) // m1 attempt 1
    .mockResolvedValueOnce(serverErrorResponse(500)) // m1 attempt 2 (same-model retry) → give up
    .mockResolvedValueOnce(serverErrorResponse(503)) // m2 attempt 1
    .mockResolvedValueOnce(serverErrorResponse(503)) // m2 attempt 2 (same-model retry) → give up
    .mockResolvedValueOnce(fakeGeminiResponse(JSON.stringify([{ ticker: "AAA", name: "A" }]))); // m3 succeeds
  vi.stubGlobal("fetch", fetchMock);
  try {
    const promise = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual([{ ticker: "AAA", name: "A" }]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain("/m1:");
    expect(urls[1]).toContain("/m1:");
    expect(urls[2]).toContain("/m2:");
    expect(urls[3]).toContain("/m2:");
    expect(urls[4]).toContain("/m3:");
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("geminiJSON: once the ~75s patience budget is exhausted, later attempts skip further sleeps and fail as model_unavailable-mapped", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2,m3,m4,m5,m6";
  const callTimes: number[] = [];
  const fetchMock = vi.fn().mockImplementation(async () => {
    callTimes.push(Date.now());
    // Every model is rate-limited with a long suggested delay (capped at the
    // helper's 20s ceiling) — the worst case the budget exists to bound.
    return rateLimitedResponse("30s");
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const promise = geminiJSON("prompt", "fake-key").catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("GEMINI_BUDGET_EXCEEDED");
    // Every model in the chain was still attempted at least once — the
    // budget cuts sleeping, not the fallback chain itself.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]);
    // Early gaps reflect the patient ~20s same-model retry wait...
    expect(gaps.some((g) => g >= 15_000)).toBe(true);
    // ...but once the 75s budget is spent, later gaps collapse to ~0 (no
    // further sleeping) instead of repeating that patient wait.
    expect(gaps.some((g) => g === 0)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
