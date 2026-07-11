# InvestSite — Intrinsic Value Page v2, The Story, AI Insights v2

**Date:** 2026-07-11
**Status:** Spec — build after valuation verification signed off
**Source:** structure extracted from the subscribed reference product
across 20 tickers; all formulas below are already implemented and calibrated in
`lib/finance/*` unless marked NEW.

## A. Intrinsic Value page v2 — five stacked sections

Replaces the current single-table Value page. Each section is a numbered white
card (00–04), matching the existing design system.

### 00 · Composite Fair Value  (exists — reuse)
Current stat header + 10-method table + knobs + footnote. Add: "Updated {date}"
caption and an Undervalued/Fairly/Overvalued pill (reuse SignalBadge).

### 01 · Quality Gate  (engine BUILT — UI card exists on Overview; link/duplicate here)
4 sub-factors × 25 pts (ROIC vs WACC, Gross Margin Trend, Revenue Quality,
Capital Allocation), pass ≥ 60, grade A–F. Formulas in `lib/finance/gate.ts`,
scoring kernels reproduce the reference's scores on 9/9 extracted samples
(gross-margin ±2). Show: grade badge, score bar 0–100 with pass-threshold tick,
4 factor rows with readings, per-factor score chips.

### 02 · Long-Horizon DCF  (engine exists — needs its own UI section, NEW)
The verified 3-stage calculator with EDITABLE inputs, prefilled from our data
(exactly like the reference exposes its inputs):
- Inputs: Operating CF TTM ($M) · Total debt · Cash & ST investments ·
  Discount rate % (auto = CAPM 5.5 ERP cap 12) · Shares (M) ·
  Growth Y1–5 % (auto = 5Y rev CAGR, floor 2, cap 30) · Growth Y6–10
  (auto = 0.7×Y1–5) · Growth Y11–20 (default 4) · 10Y treasury %.
- Output: intrinsic value/share, discount/premium vs price, pill.
- "Reset to auto values" button.
- **Reverse DCF line (NEW, small pure function):** solve g such that the
  3-stage PV equals the market cap → "Market prices in X% 20Y avg growth —
  ±Ypp vs your model's Z%." (bisection on the seed, 20 iters, pure).

### 03 · Earnings Power & Owner Yield  (NEW — two small pure models)
- **EPV (zero growth):** avg EBIT (3Y) × (1 − effective tax rate 3Y) = NOPAT;
  Operating EPV = NOPAT / WACC; EPV/share = (EPV + cash − debt)/shares.
  Show "price embeds an N% growth premium over no-growth EPV".
- **Owner Earnings Yield:** (NI TTM + D&A − maintenance capex[= 60% of total
  capex]) / market cap; compare vs 10Y treasury; spread in pp.
- Verdict line combining both lenses (cheap/fair/expensive · avoid/neutral/attractive).

### 04 · Multiples vs Peers & History  (NEW — data mostly present)
4 multiples (EV/EBITDA, P/FCF, P/E, EV/Revenue), each a mini-table:
Current ×, Own-history median × → implied price, Sector median × → implied
price (SECTOR_MULTIPLES already carries evRev+pFcf; ADD pe+evEbitda columns —
extracted values below), plus "premium to sector ±%".

Sector medians (extracted verbatim, Jul 2026 — extend SECTOR_MULTIPLES):
| Sector | EV/EBITDA | P/FCF | P/E | EV/Rev |
|---|---|---|---|---|
| Technology | 18 | 30 | 28 | 5.5 |
| Communication Services | 13 | 22 | 22 | 3.0 |
| Consumer Cyclical | 14 | 22 | 22 | 1.8 |
| Consumer Defensive | 14 | 22 | 22 | 2.0 |
| Healthcare | 15 | 25 | 22 | 4.5 |
| Financial Services | 10 | 13 | 13 | 3.0 |
| Industrials | 12 | 22 | 20 | 2.0 |
| Energy | 7 | 12 | 14 | 1.2 |
| Utilities | 11 | 22 | 18 | 2.5 |
| Basic Materials | 10 | 18 | 16 | 1.5 |
| Real Estate | 18 | 25 | 25 | 6.0 |

## B. "The Story" tab (NEW page)

Machine-drafted analyst note, generated entirely from OUR model outputs (no AI
needed for v1), with optional Gemini enrichment. Seven blocks:

1. **The Answer** — one paragraph: quality score, composite fair value, gap to
   price, implied-vs-delivered growth (from Reverse DCF), zone rating.
2. **The Narrative** — 2–3 machine-drafted paragraphs from the numbers (ROIC vs
   WACC, margins vs 5Y avg, what the market believes). A "Draft with AI" button
   sends the numbers block to Gemini for an editorial pass (cached like reports).
3. **The Thesis, numbered** — 3 bullets: quality reading, pricing gap, named
   floor (lowest surviving method).
4. **What It's Worth** — the 10 methods condensed + Bear/Base/Bull cards =
   lowest survivor / composite / highest survivor with % from price.
5. **The Plan** — 5 price zones derived from the model: full conviction
   (< bear floor), accumulate (< composite×0.95), hold (±5% of composite),
   patience (composite→bull midpoint), trim (> midpoint). "YOU ARE HERE" marker.
   Next catalyst = next earnings date (Yahoo calendarEvents).
6. **Kill Criteria** — 4 dormant/breached triggers computed live: ROIC ≤ WACC;
   reverse-DCF implied growth ≥ delivered 5Y growth; operating margin < 50% of
   its 5Y avg; price outside bear–bull range.
7. **Risks, ranked** — 3 static-model risks (single data source, discount-rate
   sensitivity, trend extrapolation) with live "watch" readings.

Zone thresholds and copy are ours; the reference's exact zone math wasn't
exposed, so these are defensible approximations.

## C. AI Insights v2 (extend existing Research page)

Reference product: BYO-Claude-key, 5 on-demand analyses. Ours: server-side
Gemini free tier (better: no key ask, no cost), currently 3 reports. Changes:
1. ADD two report types: **Key Risks** (regulatory/concentration/competitive/
   execution/valuation-compression, each with severity + watch metric) and
   **Valuation Deep-Dive** (walk our 10 methods' inputs, which to trust for
   this business model and why, sensitivity table) — prompts follow the
   existing pattern in lib/ai/prompts.ts (grounding: risks=true, deep-dive=false).
2. RENAME UI to "AI Insights" tab label (matches reference), keep /research route.
3. Bull Case: the reference has one; our "research" report already contains
   bull+bear — add a dedicated **Bull Case** prompt mirroring the bear one
   (argue the credible upside, steelman growth, what must go right).
   → total 6 buttons: Research · 3-Statement Model · Bear · Bull · Key Risks ·
   Valuation Deep-Dive.

## Build order
1. 04 Multiples section (pure data, extends SECTOR_MULTIPLES) —
2. 02 Long-Horizon DCF card + Reverse DCF —
3. 03 EPV & Owner Yield —
4. 01 gate card placement on the page —
5. B The Story (v1 machine-drafted, no AI) —
6. C AI Insights v2 prompts + buttons —
7. The Story "Draft with AI" enrichment.
