// tests/fixture.ts — synthetic company with round numbers.
// Latest year: revenue 1000, netIncome 200 (20% margin), opCF 300, capex 50,
// FCF 250, ebitda 350, debt 400, cash 200, equity 1000. Shares 100.
// History = 3 years of 10% decline going back (so CAGR ≈ 10%).
import { FinancialSnapshot, YearData } from "@/lib/finance/types";

function yr(year: number, f: number): YearData {
  return {
    year,
    revenue: 1000 * f,
    grossProfit: 500 * f,
    operatingIncome: 280 * f,
    netIncome: 200 * f,
    ebitda: 350 * f,
    operatingCashFlow: 300 * f,
    capex: 50 * f,
    freeCashFlow: 250 * f,
    totalDebt: 400,
    cash: 200,
    equity: 1000,
    currentAssets: 600,
    currentLiabilities: 300,
    interestExpense: 20,
    sharesOutstanding: 100,
    yearEndPrice: 40 * f,
  };
}

export const FIX: FinancialSnapshot = {
  ticker: "TEST",
  name: "Test Corp",
  currency: "USD",
  price: 40,
  marketCap: 4000,
  sharesOutstanding: 100,
  beta: 1.2,
  sector: null, // null → multiples fall back to own-history path in tests
  industry: null, // null → industry override falls through to sector/own-history
  riskFreeRate: 0.04,
  trailingEPS: 2, // netIncome 200 / 100 shares
  fetchedAt: "2026-07-10T00:00:00Z",
  // newest first: factors 1, 1/1.1, 1/1.21, 1/1.331 → each series has 10% CAGR
  years: [yr(2025, 1), yr(2024, 1 / 1.1), yr(2023, 1 / 1.21), yr(2022, 1 / 1.331)],
  ttm: null, // tests use FY-based bases unless a test sets this
  growthHistory: null,
  nextEarningsDate: null,
  currencyMismatch: false,
};
