# InvestSite — Stock Intrinsic-Value & Quality Tool

**Date:** 2026-07-10
**Status:** Draft for review

## Goal

A self-hosted web app that, given a US stock ticker, shows three pages:

1. **Overview** — fair value vs price, verdict, 6-dimension quality grade
2. **Intrinsic Value** — 10 valuation models + trimmed-mean composite, with tunable assumptions
3. **Metrics** — historical financial tables and charts

Functionally equivalent to the reference product's core loop, built independently from
public finance math and free data. No accounts, no login, no proprietary scraping.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router, TypeScript) | User choice; one app for UI + API |
| Data | `yahoo-finance2` npm package | Free, no API key, statements + quote + key stats |
| Cache | SQLite via `better-sqlite3` | Not a real DB — a 24h-TTL cache of fetched+computed JSON per ticker. No Postgres: no users, no writes |
| Charts | Recharts | Bars/lines for metrics + implied-price bars |
| Styling | Tailwind CSS | Fast, clean; NOT copying their branding |

No auth. No Postgres. No background jobs. One process.

## Data flow

```
/stock/[ticker]/(overview|value|metrics)
        │
        ▼
  getStockData(ticker)          ← lib/data/getStockData.ts
        │
        ├─ SQLite cache hit (<24h old)? → return cached JSON
        │
        └─ miss → fetch from Yahoo:
             • quote (price, market cap, shares)
             • incomeStatementHistory (~4 annual yrs)
             • balanceSheetHistory
             • cashflowStatementHistory
             • defaultKeyStatistics (beta, EPS, shares)
             • financialData (EBITDA, total debt/cash, margins)
             • ^TNX quote (10-yr Treasury → risk-free rate)
           → normalize into a FinancialSnapshot object
           → store in SQLite with timestamp
        │
        ▼
  Pure calculation layer (no I/O — unit-testable):
        • lib/finance/valuation.ts  → 10 models + composite
        • lib/finance/grading.ts    → 6 dimensions + letters
        │
        ▼
  Page renders. Assumption knobs on the Value page recompute
  client-side (valuation functions are isomorphic TS).
```

**FinancialSnapshot** (the normalized shape everything downstream consumes):
per-year arrays for revenue, grossProfit, operatingIncome, netIncome, EBITDA,
operatingCashFlow, capex, freeCashFlow, totalDebt, cash, equity, currentAssets,
currentLiabilities, interestExpense, sharesOutstanding; plus scalars: price,
marketCap, beta, trailingEPS, riskFreeRate.

Missing fields are `null`, never fabricated. A model whose inputs are null is
shown as "n/a — insufficient data" and excluded from the composite.

## Page 1 — Overview

- Ticker, name, live-ish price (cached ≤24h; a "refresh" button busts cache)
- Composite fair value, implied upside/downside %
- Signal: **Undervalued** (upside > +15%), **Fairly valued** (±15%), **Overvalued** (< −15%)
- Quality Score card: 6 dimension letter grades + overall letter grade
- One-line verdict combining valuation signal + overall quality
  (e.g. "High-quality business trading below fair value")
- **Competitors panel (lazy-loaded):** after the main content renders, a panel
  asks Gemini for the 5 closest listed competitors (one small AI call, cached
  7 days in SQLite — competitor sets rarely change), then runs each through
  the existing valuation engine (pure math + Yahoo fetch, cached 24h like any
  ticker). Rows stream in as computed: ticker · composite fair value · price ·
  upside % · link to that stock's own pages. A short delay between the 5 Yahoo
  fetches avoids throttling. Failures show per-row "n/a", never block the panel.

## Page 2 — Intrinsic Value

Table of 10 models, each row: name, variant label, horizontal bar of implied
price vs market price, implied $ value, vs-market %. Final row: composite.

### Shared inputs & knobs

| Knob | Default | Notes |
|---|---|---|
| Normal growth % | auto | median of historical revenue/FCF/EPS CAGRs, clamped to [0%, 25%] |
| Terminal growth % | 2.5 | must be < WACC (conservative default, was 3.0) |
| Margin expansion % | 0 | annual drift applied in Revenue DCF |
| WACC % | auto | CAPM: riskFree + beta × 5.0% equity premium, clamped to [6%, 20%] |
| H half-life (yrs) | 4 | H-model fade period |

Auto values are shown in the input placeholder (like "16.6% (auto)"); typing
overrides. Knobs recompute all models client-side instantly.

### The 10 models

All per-share results = equity value ÷ sharesOutstanding (implied total shares,
all classes). CALIBRATED Jul 2026 against the reference site's live calculator
(verified exact on 12 tickers across 11 sectors): the 20-yr models use a
THREE-STAGE growth path — years 1–5 at the seed (own 5Y revenue CAGR, capped
30%), years 6–10 at 0.70 × seed, years 11–20 at the terminal knob (default 4%)
— discounted at WACC = CAPM (rf + β × 5.5% ERP) capped at 12%, with NO value
credited beyond year 20 (no Gordon terminal value). Bases are TTM figures where
Yahoo provides them, else latest FY. Growth seed prefers SEC EDGAR (≥5y window).

1. **DCF-20 (Operating CF)** — project latest operating cash flow 20 yrs with
   fading g, discount each year, add discounted Gordon terminal value
   (CF₂₀×(1+g_t)/(WACC−g_t)). Add cash, subtract debt.
2. **DFCF-20 (Free CF)** — same engine, base = FCF (opCF − capex).
3. **DNI-20 (Net Income)** — same engine, base = net income. No debt/cash
   adjustment (already an equity measure).
4. **H-Model DCF** — FCF₀ × [(1+g_t) + H×(g_n−g_t)] / (WACC−g_t), H = half-life
   knob. Classic two-stage shortcut.
5. **EV/EBITDA** — fair EV = current-year EBITDA × the stock's own ~4-yr median
   EV/EBITDA multiple → equity = EV − debt + cash.
6. **EV/Revenue** — same with revenue and median EV/Revenue multiple.
7. **P/FCF** — fair equity = FCF × own ~4-yr median P/FCF multiple.
8. **Revenue DCF** — project revenue 20 yrs at fading g; net margin = current
   margin + margin-expansion knob drift (capped at +10pp total); implied net
   income each year → discount as in DNI.
9. **PEG-implied** — fair P/E = 100 × g (PEG = 1) → fair price = EPS × fair P/E.
   g = own 5Y NET-INCOME CAGR, uncapped (sanity cap 100%).
10. **Graham Revised** — V = EPS × (8.5 + 2g) × 4.4 / Y, g = growth seed
    (capped 30), Y = 5.0 fixed AAA proxy (reference-verified on 12 tickers).

**Multiples note:** EV/EBITDA uses the stock's own historical median multiple;
EV/Revenue and P/FCF use sector-median multiples extracted verbatim from the
reference site across all 11 sectors. Labeled in the UI per row.

### Composite

Trimmed mean: drop the single highest and single lowest valid model result,
average the rest. Needs ≥ 5 valid models to show; otherwise "insufficient data".
Method range (min–max across valid models) shown like the original.

## Page 3 — Metrics

For each available year (~4): revenue, gross/operating/net margin, EBITDA,
net income, operating CF, capex, FCF, total debt, cash, debt/equity, current
ratio, interest coverage, ROE, ROIC, shares outstanding.

Layout: one compact table (years as columns) + small bar/line charts for
revenue, margins, FCF, debt. YoY growth % under revenue/net income/FCF.

ROIC = NOPAT / invested capital = operatingIncome × (1 − 21%) / (equity + totalDebt − cash).

## Grading engine (6 dimensions)

Each dimension scores 0–100 via banded sub-scores (linear interpolation inside
bands), then letters: 90+ A, 80–89 B+, 70–79 B, 60–69 C+, 50–59 C, 35–49 D, <35 F.

| Dimension | Sub-scores (equal-weight unless noted) |
|---|---|
| **Profitability** | net margin (0%→0pts, 20%+→100), operating margin (0→0, 25%+→100), ROE (0→0, 20%+→100), ROIC (0→0, 15%+→100) |
| **Financial strength** | debt/equity (>2→0, <0.3→100), interest coverage (<1.5→0, >10→100), current ratio (<1→0, >2→100), net-debt-to-FCF payback (>8yr→0, <2yr→100; net cash = 100) |
| **Predictability** | coefficient of variation of revenue growth (lower = better), CV of net margin, fraction of years with positive revenue growth, fraction with positive FCF |
| **Growth quality** | revenue CAGR (0%→30, 15%+→100, negative→0), EPS CAGR (same bands), FCF CAGR (same); +10 bonus if EPS CAGR ≥ revenue CAGR; −10 if shares outstanding grew >3%/yr |
| **Economic moat** *(quantitative proxy — labeled as such)* | gross margin level (40%+→100), gross margin stability (CV), ROIC ≥12% in every available year (all→100, none→0) |
| **Valuation** | composite upside: +30%→100, 0%→50, −30%→0 (linear); blended 70/30 with current P/E vs own 4-yr median (below median = better) |

**Overall grade** = weighted mean: Profitability 20%, Financial strength 20%,
Valuation 20%, Predictability 15%, Growth quality 15%, Moat 10%.

All thresholds live in one `GRADING_BANDS` constant — tunable in one place.
These are our own calibrations, not a clone of theirs (theirs are invisible);
the structure matches standard quant grading practice.

## Page 4 — AI Research (requires GEMINI_API_KEY)

`/stock/[ticker]/research`. Three report types, each a button; generated report
streams into the page and is cached in SQLite (ticker + type, 24h TTL, with a
regenerate button).

| Report | Based on user's prompt | Generalization |
|---|---|---|
| Research report | 7-section equity research prompt | ticker/company/sector injected |
| 3-statement model | Apple 3-statement prompt | historical data comes from our FinancialSnapshot (injected verbatim), not "pull from SEC" — the model only does projections, scenarios, sensitivity |
| Bear case | RDDT bear prompt | ticker + live market price injected (replaces the hardcoded "$75") |

Implementation:
- Provider: Google Gemini free tier via `@google/genai` SDK.
  Model from `GEMINI_MODEL` env var (default `gemini-2.5-flash`; upgrade to
  Gemini 3 Flash if the key accepts it — verified at build time). Pro models
  are paid-only since Apr 2026, so Flash is the best free choice.
- Route handler `app/api/research/route.ts`, streaming (SSE passthrough).
- Every request includes the ticker's FinancialSnapshot as grounding context
  so the model's numbers match the valuation/metrics pages.
- Research report + bear case enable Google Search grounding (free tier
  includes limited grounding) for macro/competitor/catalyst freshness;
  3-statement model runs without tools.
- `GEMINI_API_KEY` from `.env.local`, server-side only, gitignored. If unset,
  the page renders an explainer instead of the buttons.
- Cost: $0 (free tier). Free Flash-tier limits are ~10 req/min, ~1,500/day —
  our AI usage (1 competitor lookup per ticker per week + on-demand reports,
  all cached) stays far below. 429s surface as "rate limited, retry shortly";
  model is swappable via GEMINI_MODEL if limits ever change.

## AI-call budget (why we won't hit limits)

| Feature | AI calls | Cache |
|---|---|---|
| Intrinsic value (all 10 models) | **0** — pure math | 24h (Yahoo data) |
| Metrics page | **0** | 24h |
| Quality grades | **0** | 24h |
| Competitor suggestions | 1 per ticker | 7 days |
| Research reports | 1 per ticker per type | 24h |

Yahoo has no official rate limit but throttles aggressive scraping; the 24h
cache plus a small delay between competitor fetches keeps volume trivial.

## Error handling

- Unknown ticker / Yahoo failure → friendly error page, no cache write.
- Any null input → that model/sub-score is excluded and shown as n/a, never
  silently zeroed.
- Terminal growth ≥ WACC in knobs → inline validation error on the field.
- Negative base cash flow → DCF models show "n/a — negative base CF".

## Testing

- Unit tests (Vitest) for every valuation model against hand-computed fixtures
  (a synthetic company with round numbers), and for grading bands (edge values).
- One integration smoke test: normalize a recorded Yahoo response fixture →
  snapshot → all models produce finite numbers.
- Manual calibration: compare composite for 2–3 well-known tickers against
  the user's screenshots for ballpark sanity (not exact-match).

## Out of scope (deliberate)

Accounts/login, Postgres, peer-group multiples, real-time prices, watchlists,
screeners, non-US tickers (may work incidentally via Yahoo but unsupported),
their visual branding, exporting/PDF.

## Known limits

- ~4 annual years from Yahoo (not 5) — affects CAGR smoothing only.
- `yahoo-finance2` is an unofficial API; if Yahoo changes, the data layer is
  the single module to fix (everything downstream reads FinancialSnapshot).
- Moat and Predictability are quantitative proxies; no qualitative judgment.
