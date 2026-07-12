import { beforeEach, expect, test, vi } from "vitest";

// Mock the yahoo-finance2 class so similarTickers (lib/data/yahoo.ts) never
// hits the network. Only the two methods it calls are wired up; other
// methods used elsewhere in lib/data/yahoo.ts are stubbed as no-ops since
// this file only exercises similarTickers.
const recommendationsBySymbolMock = vi.fn();
const quoteMock = vi.fn();

vi.mock("yahoo-finance2", () => ({
  default: class {
    constructor(_opts?: unknown) {}
    recommendationsBySymbol = recommendationsBySymbolMock;
    quote = quoteMock;
    search = vi.fn();
    quoteSummary = vi.fn();
    fundamentalsTimeSeries = vi.fn();
    chart = vi.fn();
  },
}));

const { similarTickers } = await import("@/lib/data/yahoo");

beforeEach(() => {
  recommendationsBySymbolMock.mockReset();
  quoteMock.mockReset();
});

test("filters the input ticker, caps at 5, names from quote(), falls back to symbol", async () => {
  recommendationsBySymbolMock.mockResolvedValue({
    symbol: "META",
    recommendedSymbols: [
      { symbol: "META", score: 1 }, // self — filtered out
      { symbol: "GOOGL", score: 0.9 },
      { symbol: "SNAP", score: 0.8 },
      { symbol: "PINS", score: 0.7 },
      { symbol: "^GSPC", score: 0.6 }, // index — filtered as non-equity junk
      { symbol: "TTWO", score: 0.5 },
      { symbol: "RDDT", score: 0.4 }, // 6th distinct candidate — beyond the top-5 cap
    ],
  });
  quoteMock.mockResolvedValue([
    { symbol: "GOOGL", longName: "Alphabet Inc.", quoteType: "EQUITY" },
    { symbol: "SNAP", shortName: "Snap Inc", quoteType: "EQUITY" },
    // PINS: no quote returned at all -> name falls back to the ticker string
    { symbol: "^GSPC", quoteType: "INDEX" },
    { symbol: "TTWO", longName: "Take-Two Interactive", quoteType: "EQUITY" },
  ]);

  const result = await similarTickers("meta");

  expect(result).toEqual([
    { ticker: "GOOGL", name: "Alphabet Inc." },
    { ticker: "SNAP", name: "Snap Inc" },
    { ticker: "PINS", name: "PINS" },
    { ticker: "TTWO", name: "Take-Two Interactive" },
  ]);
  // RDDT was never even looked up — it's the 6th candidate, past the top-5 cap.
  expect(quoteMock).toHaveBeenCalledWith(
    ["GOOGL", "SNAP", "PINS", "^GSPC", "TTWO"],
    {},
    { validateResult: false }
  );
});

test("recommendationsBySymbol throwing yields an empty list", async () => {
  recommendationsBySymbolMock.mockRejectedValue(new Error("network"));
  expect(await similarTickers("META")).toEqual([]);
});

test("empty recommendedSymbols yields an empty list without calling quote()", async () => {
  recommendationsBySymbolMock.mockResolvedValue({ symbol: "META", recommendedSymbols: [] });
  expect(await similarTickers("META")).toEqual([]);
  expect(quoteMock).not.toHaveBeenCalled();
});

test("quote() throwing still returns candidates, falling back to ticker strings as names", async () => {
  recommendationsBySymbolMock.mockResolvedValue({
    symbol: "META",
    recommendedSymbols: [{ symbol: "GOOGL", score: 0.9 }],
  });
  quoteMock.mockRejectedValue(new Error("quote network error"));

  expect(await similarTickers("META")).toEqual([{ ticker: "GOOGL", name: "GOOGL" }]);
});
