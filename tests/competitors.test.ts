import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Reason: same isolation trick as tests/db.test.ts — set the cache DB path
// before anything imports lib/db (directly or transitively via the route),
// so this test never touches the real data/cache.db.
process.env.CACHE_DB_PATH = "/tmp/investsite-test-competitors-cache.db";

const similarTickersMock = vi.fn();
vi.mock("@/lib/data/yahoo", () => ({
  similarTickers: (...args: unknown[]) => similarTickersMock(...args),
}));

// Minimal stand-in for parseCompetitors' real validation — good enough for
// exercising the route's fallback wiring without depending on
// lib/ai/gemini.ts internals (owned by a concurrent edit elsewhere).
const geminiJSONMock = vi.fn();
vi.mock("@/lib/ai/gemini", () => ({
  geminiJSON: (...args: unknown[]) => geminiJSONMock(...args),
  parseCompetitors: (raw: unknown) =>
    Array.isArray(raw)
      ? raw
          .filter((r): r is { ticker: string; name?: string } => typeof (r as any)?.ticker === "string")
          .map((r) => ({ ticker: r.ticker.toUpperCase(), name: r.name ?? r.ticker }))
      : [],
}));

const { cacheDel } = await import("@/lib/db");
const { GET } = await import("@/app/api/competitors/[ticker]/route");

function req() {
  return new Request("http://localhost/api/competitors/META");
}
function ctx() {
  return { params: Promise.resolve({ ticker: "META" }) };
}

beforeEach(() => {
  similarTickersMock.mockReset();
  geminiJSONMock.mockReset();
  cacheDel("competitors:META");
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("Yahoo success: returns Yahoo's list and never calls Gemini", async () => {
  similarTickersMock.mockResolvedValue([
    { ticker: "GOOGL", name: "Alphabet" },
    { ticker: "SNAP", name: "Snap Inc" },
  ]);

  const res = await GET(req(), ctx());
  const data = await res.json();

  expect(data.competitors).toEqual([
    { ticker: "GOOGL", name: "Alphabet" },
    { ticker: "SNAP", name: "Snap Inc" },
  ]);
  expect(geminiJSONMock).not.toHaveBeenCalled();
  // Yahoo is the un-badged primary source — no model field on this path.
  expect(data.model).toBeUndefined();
});

test("Yahoo empty list: falls back to Gemini, and the response names the serving model", async () => {
  similarTickersMock.mockResolvedValue([]);
  geminiJSONMock.mockResolvedValue({
    value: [{ ticker: "nflx", name: "Netflix" }],
    model: "gemini-2.5-flash",
  });

  const res = await GET(req(), ctx());
  const data = await res.json();

  expect(geminiJSONMock).toHaveBeenCalledTimes(1);
  expect(data.competitors).toEqual([{ ticker: "NFLX", name: "Netflix" }]);
  // Model attribution: Yahoo (the un-badged primary source) came up empty, so
  // the response says which model actually produced this list.
  expect(data.model).toBe("gemini-2.5-flash");
});

test("Yahoo throws: falls back to Gemini, and the response names the serving model", async () => {
  similarTickersMock.mockRejectedValue(new Error("yahoo boom"));
  geminiJSONMock.mockResolvedValue({
    value: [{ ticker: "nflx", name: "Netflix" }],
    model: "gemini-3.1-flash-lite",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  const res = await GET(req(), ctx());
  const data = await res.json();

  expect(geminiJSONMock).toHaveBeenCalledTimes(1);
  expect(data.competitors).toEqual([{ ticker: "NFLX", name: "Netflix" }]);
  expect(data.model).toBe("gemini-3.1-flash-lite");
});

test("Yahoo success populates the cache so a second request skips Yahoo entirely", async () => {
  similarTickersMock.mockResolvedValue([{ ticker: "GOOGL", name: "Alphabet" }]);

  await GET(req(), ctx());
  similarTickersMock.mockClear();

  const res2 = await GET(req(), ctx());
  const data2 = await res2.json();

  expect(similarTickersMock).not.toHaveBeenCalled();
  expect(geminiJSONMock).not.toHaveBeenCalled();
  expect(data2.competitors).toEqual([{ ticker: "GOOGL", name: "Alphabet" }]);
});
