import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  clearGeminiModelCooldowns,
  geminiJSON,
  GEMINI_REQUEST_BUDGET_MS,
  modelChain,
  parseCompetitors,
  sseTextStream,
  scrubReasoningLeak,
} from "@/lib/ai/gemini";

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
  // The 429 cooldown map is module-level (deliberately, for warm serverless
  // instances) — clear it so one test's learned cooldowns can't leak into
  // another's sprint pass.
  clearGeminiModelCooldowns();
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
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    // grounded-capable 2.5-flash before gemma: grounded reports keep live
    // search (and a separate free quota) as long as possible
    "gemini-2.5-flash",
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
    expect(result.value).toEqual([{ ticker: "MSFT", name: "Microsoft" }]);
    // Model attribution: the FALLBACK model actually served this, not the
    // primary whose malformed JSON was discarded.
    expect(result.model).toBe("gemini-3.1-flash-lite");
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

test("geminiJSON: sprint pass — a 429 falls straight to the next model (1s courtesy gap, no patient same-model wait)", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2";
  const callTimes: number[] = [];
  const fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
    callTimes.push(Date.now());
    // m1's 30s hint must NOT be waited on in pass 1 — that's the whole point
    // of sprinting: the primary's quota is usually the exhausted one.
    return String(url).includes("/m1:")
      ? rateLimitedResponse("30s")
      : fakeGeminiResponse(JSON.stringify([{ ticker: "MSFT", name: "Microsoft" }]));
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const promise = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.value).toEqual([{ ticker: "MSFT", name: "Microsoft" }]);
    expect(result.model).toBe("m2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/m1:");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/m2:");
    // Only the 1s courtesy gap between models — not the 30s the 429 suggested.
    expect(callTimes[1] - callTimes[0]).toBeLessThanOrEqual(1000);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("geminiJSON: all models 429 in the sprint → patient pass 2 honors the suggested delay and can succeed; chain order preserved in both passes", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2";
  const callTimes: number[] = [];
  let calls = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    callTimes.push(Date.now());
    calls++;
    if (calls === 1) return rateLimitedResponse("2s"); // pass 1: m1
    if (calls === 2) return rateLimitedResponse("3s"); // pass 1: m2
    // pass 2: m1, quota window rolled over.
    return fakeGeminiResponse(JSON.stringify([{ ticker: "AAA", name: "A" }]));
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const promise = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.value).toEqual([{ ticker: "AAA", name: "A" }]);
    expect(result.model).toBe("m1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    // Chain order preserved: pass 1 walks m1→m2, pass 2 re-walks from m1.
    expect(urls[0]).toContain("/m1:");
    expect(urls[1]).toContain("/m2:");
    expect(urls[2]).toContain("/m1:");
    // Pass 2 waited out m1's suggested 2s before re-attempting it.
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(2000);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("geminiJSON: 500/503 sprint through pass 1 fast, then get a 4s pass-2 wait", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2";
  const callTimes: number[] = [];
  let calls = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    callTimes.push(Date.now());
    calls++;
    if (calls === 1) return serverErrorResponse(500); // pass 1: m1
    if (calls === 2) return serverErrorResponse(503); // pass 1: m2
    return fakeGeminiResponse(JSON.stringify([{ ticker: "BBB", name: "B" }])); // pass 2: m1
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const promise = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.value).toEqual([{ ticker: "BBB", name: "B" }]);
    expect(result.model).toBe("m1");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(3);
    expect(urls[2]).toContain("/m1:");
    // Pass 1: only the 1s courtesy gap, no 4s wait yet.
    expect(callTimes[1] - callTimes[0]).toBeLessThanOrEqual(1000);
    // Pass 2: the fixed 4s wait for a 5xx before re-attempting m1.
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(4000);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("geminiJSON: the ~75s budget caps total wall time — pass 2 stops sleeping and fails as GEMINI_BUDGET_EXCEEDED", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2,m3,m4,m5,m6";
  const fetchMock = vi.fn().mockImplementation(async () => {
    // Every model rate-limited with a long suggested delay (capped at the
    // 20s ceiling) — the worst case the budget exists to bound.
    return rateLimitedResponse("30s");
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const start = Date.now();
    const promise = geminiJSON("prompt", "fake-key").catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("GEMINI_BUDGET_EXCEEDED");
    // Total wall time never exceeds the budget.
    expect(Date.now() - start).toBeLessThanOrEqual(GEMINI_REQUEST_BUDGET_MS);
    // Pass 1 attempted the whole chain in order; pass 2 re-walked from m1
    // until the budget ran out (6 sprint + 4 patient with 20s waits: the
    // 4th patient wait is clamped to the 10s left, then pass 2 stops).
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(10);
    expect(urls.slice(0, 6).map((u, i) => u.includes(`/m${i + 1}:`))).toEqual(
      Array(6).fill(true)
    );
    expect(urls.slice(6).map((u, i) => u.includes(`/m${i + 1}:`))).toEqual(
      Array(4).fill(true)
    );
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("geminiJSON: module-level cooldown lets the NEXT request skip a just-429'd model in its sprint pass", async () => {
  vi.useFakeTimers();
  process.env.GEMINI_MODEL = "m1";
  process.env.GEMINI_FALLBACK_MODELS = "m2";
  const fetchMock = vi.fn().mockImplementation(async (url: unknown) =>
    String(url).includes("/m1:")
      ? rateLimitedResponse("10s")
      : fakeGeminiResponse(JSON.stringify([{ ticker: "CCC", name: "C" }]))
  );
  vi.stubGlobal("fetch", fetchMock);
  try {
    // Request 1: m1 429s (teaching the cooldown map), m2 succeeds.
    const first = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.runAllTimersAsync();
    const firstResult = await first;
    expect(firstResult.value).toEqual([{ ticker: "CCC", name: "C" }]);
    expect(firstResult.model).toBe("m2");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Request 2 (moments later, same warm instance): m1 is inside its 10s
    // cooldown → skipped without spending a request; m2 is hit directly.
    fetchMock.mockClear();
    const second = geminiJSON<{ ticker: string; name: string }[]>("prompt", "fake-key");
    await vi.runAllTimersAsync();
    const secondResult = await second;
    expect(secondResult.value).toEqual([{ ticker: "CCC", name: "C" }]);
    expect(secondResult.model).toBe("m2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/m2:");
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

// --- Reasoning-leak scrubbing (cosmetic streaming bug, task-47) ------------
// Fallback models (esp. gemma, which has no `thought` flag) occasionally leak
// internal planning/preamble as visible text ahead of the actual report.

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

test("sseTextStream: drops parts flagged thought:true, keeps real content", async () => {
  const chunks = [
    sseLine({
      candidates: [
        {
          content: {
            parts: [{ text: "Let me think about how to structure this...", thought: true }],
          },
        },
      ],
    }),
    sseLine({
      candidates: [{ content: { parts: [{ text: "## Report\nReal content." }] } }],
    }),
  ];
  const out = await readAll(sseTextStream(streamFromChunks(chunks)));
  expect(out).toBe("## Report\nReal content.");
});

test("sseTextStream: a thought part alongside a real part in the same message keeps only the real one", async () => {
  const chunks = [
    sseLine({
      candidates: [
        {
          content: {
            parts: [
              { text: "Planning the response structure.", thought: true },
              { text: "## Overview\nSolid fundamentals." },
            ],
          },
        },
      ],
    }),
  ];
  const out = await readAll(sseTextStream(streamFromChunks(chunks)));
  expect(out).toBe("## Overview\nSolid fundamentals.");
});

test("scrubReasoningLeak: strips an 'Okay, the user wants...' preamble before a heading", async () => {
  const text =
    "Okay, the user wants a deep-dive report on this company's fundamentals and valuation.\n\n## Overview\nThe company is solid.";
  const out = await readAll(scrubReasoningLeak(streamFromChunks([text])));
  expect(out).toBe("## Overview\nThe company is solid.");
});

test("scrubReasoningLeak: a legit report opening with a plain paragraph passes through untouched", async () => {
  const text =
    "This company represents a compelling investment opportunity in a growing sector.\n\n## Overview\nDetails here.";
  const out = await readAll(scrubReasoningLeak(streamFromChunks([text])));
  expect(out).toBe(text);
});

test("scrubReasoningLeak: strips a <thinking>...</thinking> block", async () => {
  const text =
    "<thinking>\nInternal reasoning that should never be shown to the user.\n</thinking>\n\n## Overview\nReal content.";
  const out = await readAll(scrubReasoningLeak(streamFromChunks([text])));
  expect(out).toBe("## Overview\nReal content.");
});

test("scrubReasoningLeak: handles the preamble split across chunk boundaries mid-pattern", async () => {
  const full =
    "Okay, let me think through the filings and figures first before writing.\n\n## Overview\nSolid fundamentals.";
  // Split mid-word ("Ok" | "ay, let me thi" | "nk through...") to exercise
  // buffering across pull() calls rather than one clean chunk.
  const c1 = full.slice(0, 2);
  const c2 = full.slice(2, 30);
  const c3 = full.slice(30);
  const out = await readAll(scrubReasoningLeak(streamFromChunks([c1, c2, c3])));
  expect(out).toBe("## Overview\nSolid fundamentals.");
});

test("scrubReasoningLeak: a <thinking> block split across chunks is still stripped", async () => {
  const full =
    "<thinking>step one, step two, step three of the analysis</thinking>\n\n## Overview\nReal content.";
  const c1 = full.slice(0, 15);
  const c2 = full.slice(15, 50);
  const c3 = full.slice(50);
  const out = await readAll(scrubReasoningLeak(streamFromChunks([c1, c2, c3])));
  expect(out).toBe("## Overview\nReal content.");
});

const DECISION_WINDOW_TEST_THRESHOLD = 800;
const REASONING_SCAN_CAP_TEST_THRESHOLD = 8_192;

test("scrubReasoningLeak: a ~2.5KB reasoning leak before the heading is stripped (real gemma ONDS-playbook shape)", async () => {
  // Models the observed poisoned cache entry: repeated planning notes and
  // indented bullet fragments, well past the old 800-char window, then the
  // real report heading.
  const leak =
    "Okay, the user wants The Playbook for Ondas Inc. (ONDS).\n" +
    "    *   Catalyst Calendar.\n    *   Scenario Analysis with price targets.\n".repeat(30) +
    "No inventing figures, anchor all prices to the provided valuation table.\n";
  const report = "# The Playbook: Ondas Inc. (ONDS)\n\n**Current Price:** 7.26\n";
  const text = leak + report;
  expect(leak.length).toBeGreaterThan(2_000);
  expect(leak.length).toBeLessThan(REASONING_SCAN_CAP_TEST_THRESHOLD);
  // Deliver in streaming-sized chunks to exercise repeated buffering.
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 400) chunks.push(text.slice(i, i + 400));
  const out = await readAll(scrubReasoningLeak(streamFromChunks(chunks)));
  expect(out).toBe(report);
});

test("scrubReasoningLeak: a legit long opening with no heading is untouched and not held past the 800-char window", async () => {
  // A non-reasoning opening must be released as soon as the quick window is
  // spent — even while the stream is still open (never held for the 8KB scan).
  const opening = "The company posted strong results across all segments. ".repeat(20); // > 800 chars
  expect(opening.length).toBeGreaterThan(DECISION_WINDOW_TEST_THRESHOLD);
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const reader = scrubReasoningLeak(source).getReader();
  controller.enqueue(enc.encode(opening));
  // Stream deliberately NOT closed — the read below only resolves if the
  // scrubber decided (passed through) at the window rather than buffering on.
  const { done, value } = await reader.read();
  expect(done).toBe(false);
  expect(new TextDecoder().decode(value)).toBe(opening);
  controller.close();
});

test("scrubReasoningLeak: reasoning-looking opening with no heading within the 8KB cap passes through whole", async () => {
  const text = "Okay, let me think about this. ".repeat(300); // ~9.3KB, no heading anywhere
  expect(text.length).toBeGreaterThan(REASONING_SCAN_CAP_TEST_THRESHOLD);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 500) chunks.push(text.slice(i, i + 500));
  const out = await readAll(scrubReasoningLeak(streamFromChunks(chunks)));
  expect(out).toBe(text);
});

test("scrubReasoningLeak: a short legit response with no heading at all passes through untouched", async () => {
  const text = "Net income grew 12% year over year on stronger margins.";
  const out = await readAll(scrubReasoningLeak(streamFromChunks([text])));
  expect(out).toBe(text);
});

test("geminiJSON: modelsOverride replaces the default chain", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
  delete process.env.GEMINI_FALLBACK_MODELS;
  const tried: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    tried.push(String(url));
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }),
      { status: 200 }
    );
  }) as any;
  try {
    const { geminiJSON } = await import("@/lib/ai/gemini");
    const { model } = await geminiJSON("x", undefined, ["gemma-4-31b-it"]);
    expect(model).toBe("gemma-4-31b-it");
    expect(tried).toHaveLength(1);
    expect(tried[0]).toContain("/gemma-4-31b-it:");
  } finally {
    globalThis.fetch = realFetch;
  }
});
