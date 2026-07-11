import { expect, test } from "vitest";
import { normalizeSnapshot, convertSnapshotCurrency, RawBundle } from "@/lib/data/yahoo";

const raw: RawBundle = {
  riskFree: 0.042,
  chartQuotes: [
    { date: "2024-12-30", close: 90 },
    { date: "2025-12-29", close: 100 },
  ],
  qs: {
    price: { regularMarketPrice: 105, longName: "Acme Inc", currency: "USD", marketCap: 10500 },
    defaultKeyStatistics: { beta: 1.1, trailingEps: 4.2, sharesOutstanding: 100 },
    financialData: { totalDebt: 300, totalCash: 150 },
    incomeStatementHistory: {
      incomeStatementHistory: [
        { endDate: "2025-12-31", totalRevenue: 1000, grossProfit: 480, operatingIncome: 260, netIncome: 200, interestExpense: -15 },
        { endDate: "2024-12-31", totalRevenue: 900, grossProfit: 430, operatingIncome: 230, netIncome: 180, interestExpense: -14 },
      ],
    },
    balanceSheetHistory: {
      balanceSheetStatements: [
        { endDate: "2025-12-31", totalCurrentAssets: 500, totalCurrentLiabilities: 250, totalStockholderEquity: 900, shortLongTermDebt: 50, longTermDebt: 250, cash: 100, shortTermInvestments: 50 },
        { endDate: "2024-12-31", totalCurrentAssets: 450, totalCurrentLiabilities: 240, totalStockholderEquity: 800, shortLongTermDebt: 40, longTermDebt: 260, cash: 90, shortTermInvestments: 40 },
      ],
    },
    cashflowStatementHistory: {
      cashflowStatements: [
        { endDate: "2025-12-31", totalCashFromOperatingActivities: 280, capitalExpenditures: -60, depreciation: 70 },
        { endDate: "2024-12-31", totalCashFromOperatingActivities: 250, capitalExpenditures: -55, depreciation: 65 },
      ],
    },
  },
};

test("normalizes into newest-first years with derived fields", () => {
  const s = normalizeSnapshot(raw, "acme");
  expect(s.ticker).toBe("ACME");
  expect(s.price).toBe(105);
  expect(s.years).toHaveLength(2);
  const y0 = s.years[0];
  expect(y0.year).toBe(2025);
  expect(y0.revenue).toBe(1000);
  expect(y0.capex).toBe(60); // abs()
  expect(y0.freeCashFlow).toBe(220); // 280 - 60
  expect(y0.ebitda).toBe(330); // opInc 260 + dep 70
  expect(y0.totalDebt).toBe(300); // 50 + 250
  expect(y0.cash).toBe(150); // cash + shortTermInvestments
  expect(y0.interestExpense).toBe(15); // abs()
  expect(y0.yearEndPrice).toBe(100); // close nearest 2025-12-31
  expect(s.years[1].yearEndPrice).toBe(90);
  expect(s.currencyMismatch).toBe(false); // default; no ADR currency conflict
});

test("convertSnapshotCurrency scales money fields, leaves shares/price/count", () => {
  const s = normalizeSnapshot(raw, "acme");
  // Give it a TTM base so all three TTM money fields are exercised.
  const src = { ...s, ttm: { operatingCashFlow: 280, freeCashFlow: 220, netIncome: 420 } };
  const rate = 0.031; // e.g. TWD→USD
  const c = convertSnapshotCurrency(src, rate);

  const y0 = c.years[0];
  expect(y0.revenue).toBeCloseTo(1000 * rate, 10);
  expect(y0.grossProfit).toBeCloseTo(480 * rate, 10);
  expect(y0.operatingIncome).toBeCloseTo(260 * rate, 10);
  expect(y0.netIncome).toBeCloseTo(200 * rate, 10);
  expect(y0.ebitda).toBeCloseTo(330 * rate, 10);
  expect(y0.operatingCashFlow).toBeCloseTo(280 * rate, 10);
  expect(y0.capex).toBeCloseTo(60 * rate, 10);
  expect(y0.freeCashFlow).toBeCloseTo(220 * rate, 10);
  expect(y0.totalDebt).toBeCloseTo(300 * rate, 10);
  expect(y0.cash).toBeCloseTo(150 * rate, 10);
  expect(y0.currentAssets).toBeCloseTo(500 * rate, 10);
  expect(y0.currentLiabilities).toBeCloseTo(250 * rate, 10);
  expect(y0.interestExpense).toBeCloseTo(15 * rate, 10);
  // Unscaled: a share count and the already-USD ADR close price.
  expect(y0.sharesOutstanding).toBe(src.years[0].sharesOutstanding);
  expect(y0.yearEndPrice).toBe(100);
  // TTM cash-flow bases (from financialData → home ccy) scaled.
  expect(c.ttm!.operatingCashFlow).toBeCloseTo(280 * rate, 10);
  expect(c.ttm!.freeCashFlow).toBeCloseTo(220 * rate, 10);
  // ttm.netIncome is trailingEPS-derived (already trading ccy) → NOT scaled,
  // else DNI-20 double-converts (TSM would collapse to ~$8/share).
  expect(c.ttm!.netIncome).toBe(420);
  // Top-level price/marketCap/shares are the ADR trading currency — untouched.
  expect(c.price).toBe(105);
  expect(c.marketCap).toBe(10500);
  expect(c.sharesOutstanding).toBe(src.sharesOutstanding);
});

test("missing statements → empty years, still returns snapshot", () => {
  const s = normalizeSnapshot(
    { ...raw, qs: { ...raw.qs, incomeStatementHistory: undefined } },
    "ACME"
  );
  expect(s.years).toHaveLength(0);
});
