# InvestSite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Next.js app that, given a US ticker, shows Overview (fair value + 6-dimension quality grades + competitors), Intrinsic Value (10 models + composite with tunable knobs), Metrics (historical financials), and AI Research (3 Gemini-generated reports).

**Architecture:** One Next.js (App Router, TS) app. `lib/finance/*` is pure math (no I/O, unit-tested, runs on server AND client for live knob recompute). `lib/data/yahoo.ts` normalizes yahoo-finance2 output into a `FinancialSnapshot`; `lib/db.ts` is a SQLite TTL cache. Gemini free tier via plain `fetch` (no SDK) for competitor suggestions + streamed research reports.

**Tech Stack:** Next.js 15 (App Router, TypeScript), Tailwind CSS v4, yahoo-finance2, better-sqlite3, Vitest. NO Recharts (bars are plain divs — fewer deps). NO Gemini SDK (plain fetch).

**Suggested subagent models:** Tasks 1, 7, 8, 9 → `sonnet`. Tasks 2, 3, 4, 5, 6, 10, 11 → `opus`. (Orchestrator/review = main session.)

## Global Constraints

- Spec: `docs/specs/2026-07-10-investsite-design.md` (source of truth for formulas).
- All money math in `lib/finance/` must be pure functions — no fetch, no fs, no Date.now.
- Missing data → `null` propagated + human-readable `note`; NEVER fabricate or default to 0 for financial values.
- Cache TTLs: stock data 24h, competitor list 7 days, research reports 24h.
- Env (already in `.env.local`, gitignored): `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.5-flash`.
- SQLite file `data/cache.db` (gitignored via `*.db`).
- Commit after every task with a conventional message.
- App lives at repo root `/Users/jingxuan/InvestSite`.

---

### Task 1: Scaffold Next.js app + Vitest

**Files:**
- Create: Next.js scaffold at repo root (package.json, tsconfig.json, next.config.ts, app/, postcss/tailwind config)
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts + deps)

**Interfaces:**
- Produces: working `npm run dev`, `npm test`, path alias `@/*` → repo root.

- [ ] **Step 1: Scaffold in place** (repo root already has docs/ and .git — scaffold into a temp dir and move, since create-next-app refuses non-empty dirs)

```bash
cd /Users/jingxuan/InvestSite
npx create-next-app@latest tmp-scaffold --ts --tailwind --app --no-src-dir --import-alias "@/*" --use-npm --no-eslint --turbopack
rsync -a tmp-scaffold/ ./ --exclude .git
rm -rf tmp-scaffold
```

- [ ] **Step 2: Install runtime + test deps**

```bash
npm i yahoo-finance2 better-sqlite3
npm i -D vitest @types/better-sqlite3
```

- [ ] **Step 3: Configure** — `next.config.ts`:

```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "yahoo-finance2"],
};
export default nextConfig;
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname) } },
});
```

Add to `package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 4: Smoke check** — Run `npm run build`. Expected: builds successfully. Create `tests/smoke.test.ts`:

```ts
import { expect, test } from "vitest";
test("vitest runs", () => expect(1 + 1).toBe(2));
```

Run `npm test` → 1 passed.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "chore: scaffold Next.js app with vitest"` (verify `.env.local` and `*.db` are NOT staged — `.gitignore` from scaffold must be merged with existing one keeping `.env*.local` and `*.db` lines).

---

### Task 2: SQLite TTL cache (`lib/db.ts`)

**Files:**
- Create: `lib/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `cacheGet<T>(key: string): T | null`, `cacheSet(key: string, value: unknown, ttlSeconds: number): void`, `cacheDel(key: string): void`.

- [ ] **Step 1: Write the failing test** — `tests/db.test.ts`:

```ts
import { expect, test, beforeEach } from "vitest";
process.env.CACHE_DB_PATH = "/tmp/investsite-test-cache.db";
import { cacheGet, cacheSet, cacheDel } from "@/lib/db";

beforeEach(() => cacheDel("k"));

test("set then get returns value", () => {
  cacheSet("k", { a: 1 }, 60);
  expect(cacheGet<{ a: number }>("k")).toEqual({ a: 1 });
});

test("expired entry returns null", () => {
  cacheSet("k", "v", -1); // already expired
  expect(cacheGet("k")).toBeNull();
});

test("missing key returns null", () => {
  expect(cacheGet("nope")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails** — `npm test` → FAIL (module not found).

- [ ] **Step 3: Implement** — `lib/db.ts`:

```ts
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath =
  process.env.CACHE_DB_PATH ?? path.join(process.cwd(), "data", "cache.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)"
);

export function cacheGet<T>(key: string): T | null {
  const row = db
    .prepare("SELECT value, expires FROM cache WHERE key = ?")
    .get(key) as { value: string; expires: number } | undefined;
  if (!row) return null;
  if (row.expires < Date.now()) {
    cacheDel(key);
    return null;
  }
  return JSON.parse(row.value) as T;
}

export function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)"
  ).run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
}

export function cacheDel(key: string): void {
  db.prepare("DELETE FROM cache WHERE key = ?").run(key);
}
```

- [ ] **Step 4: Run tests** — `npm test` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: sqlite ttl cache"`.

---

### Task 3: Finance types + helpers + auto-assumptions

**Files:**
- Create: `lib/finance/types.ts`, `lib/finance/helpers.ts`, `lib/finance/assumptions.ts`
- Test: `tests/assumptions.test.ts`

**Interfaces:**
- Produces (types used by EVERY later task):

`lib/finance/types.ts` (complete file):

```ts
export interface YearData {
  year: number; // fiscal year, e.g. 2025
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  ebitda: number | null; // operatingIncome + depreciation (approximation)
  operatingCashFlow: number | null;
  capex: number | null; // POSITIVE spend
  freeCashFlow: number | null; // operatingCashFlow - capex
  totalDebt: number | null;
  cash: number | null;
  equity: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  interestExpense: number | null; // positive
  sharesOutstanding: number | null;
  yearEndPrice: number | null; // close nearest fiscal year end
}

export interface FinancialSnapshot {
  ticker: string;
  name: string;
  currency: string;
  price: number;
  marketCap: number | null;
  sharesOutstanding: number;
  beta: number | null;
  trailingEPS: number | null;
  riskFreeRate: number; // decimal e.g. 0.042
  years: YearData[]; // NEWEST FIRST, up to ~4 entries
  fetchedAt: string; // ISO
}

export interface Assumptions {
  normalGrowth: number; // decimal, e.g. 0.12
  terminalGrowth: number; // decimal, default 0.03
  marginExpansion: number; // pp/year as decimal, e.g. 0.005 = +0.5pp/yr, default 0
  wacc: number; // decimal
  hHalfLife: number; // years, default 4
}

export interface ModelResult {
  key: string;
  name: string; // e.g. "DCF-20"
  variant: string; // e.g. "20Y · Operating CF"
  value: number | null; // implied price per share
  note?: string; // reason when value is null
}

export interface ValuationOutput {
  models: ModelResult[];
  composite: number | null; // trimmed mean
  range: { min: number; max: number } | null;
  assumptions: Assumptions; // resolved (autos filled in)
  autoNormalGrowth: number;
  autoWacc: number;
}

export type Grade = "A" | "B+" | "B" | "C+" | "C" | "D" | "F";

export interface DimensionScore {
  key: string;
  name: string;
  score: number | null; // 0-100
  grade: Grade | null;
  detail: string; // e.g. "ROIC 18%, net margin 24%"
}

export interface QualityOutput {
  dimensions: DimensionScore[];
  overallScore: number | null;
  overallGrade: Grade | null;
}
```

`lib/finance/helpers.ts` (complete file):

```ts
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// CAGR from oldest to latest; null when not computable (needs both > 0)
export function cagr(latest: number, oldest: number, years: number): number | null {
  if (years <= 0 || oldest <= 0 || latest <= 0) return null;
  return Math.pow(latest / oldest, 1 / years) - 1;
}

// coefficient of variation (population sd / |mean|); null if <2 points or mean 0
export function coefVar(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m === 0) return null;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
  return sd / Math.abs(m);
}

// linear map: x0 -> 0, x1 -> 100, clamped. Works reversed (x0 > x1).
export function linearBand(x: number, x0: number, x1: number): number {
  return clamp(((x - x0) / (x1 - x0)) * 100, 0, 100);
}

// picks metric series oldest->latest from newest-first YearData-like array
export function seriesOldestFirst<T>(
  years: T[],
  pick: (y: T) => number | null
): number[] {
  return [...years]
    .reverse()
    .map(pick)
    .filter((v): v is number => v !== null && Number.isFinite(v));
}
```

`lib/finance/assumptions.ts` (complete file):

```ts
import { FinancialSnapshot, Assumptions } from "./types";
import { cagr, clamp, median, seriesOldestFirst } from "./helpers";

// median of revenue/netIncome/FCF CAGRs over available years, clamped [0, 25%]
export function autoNormalGrowth(s: FinancialSnapshot): number {
  const picks: ((y: FinancialSnapshot["years"][number]) => number | null)[] = [
    (y) => y.revenue,
    (y) => y.netIncome,
    (y) => y.freeCashFlow,
  ];
  const cagrs: number[] = [];
  for (const pick of picks) {
    const xs = seriesOldestFirst(s.years, pick);
    if (xs.length >= 2) {
      const g = cagr(xs[xs.length - 1], xs[0], xs.length - 1);
      if (g !== null) cagrs.push(g);
    }
  }
  const m = median(cagrs);
  return m === null ? 0.05 : clamp(m, 0, 0.25);
}

// CAPM: rf + beta * 5% equity risk premium, clamped [6%, 20%]
export function autoWacc(s: FinancialSnapshot): number {
  const beta = s.beta ?? 1;
  return clamp(s.riskFreeRate + beta * 0.05, 0.06, 0.2);
}

export function resolveAssumptions(
  s: FinancialSnapshot,
  overrides: Partial<Assumptions> = {}
): Assumptions {
  return {
    normalGrowth: overrides.normalGrowth ?? autoNormalGrowth(s),
    terminalGrowth: overrides.terminalGrowth ?? 0.03,
    marginExpansion: overrides.marginExpansion ?? 0,
    wacc: overrides.wacc ?? autoWacc(s),
    hHalfLife: overrides.hHalfLife ?? 4,
  };
}
```

- [ ] **Step 1: Write failing tests** — `tests/assumptions.test.ts`. Use this shared fixture (create `tests/fixture.ts`, exported for tasks 4–5 too):

```ts
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
  riskFreeRate: 0.04,
  trailingEPS: 2, // netIncome 200 / 100 shares
  fetchedAt: "2026-07-10T00:00:00Z",
  // newest first: factors 1, 1/1.1, 1/1.21, 1/1.331 → each series has 10% CAGR
  years: [yr(2025, 1), yr(2024, 1 / 1.1), yr(2023, 1 / 1.21), yr(2022, 1 / 1.331)],
};
```

`tests/assumptions.test.ts`:

```ts
import { expect, test } from "vitest";
import { autoNormalGrowth, autoWacc, resolveAssumptions } from "@/lib/finance/assumptions";
import { cagr, median, linearBand, coefVar } from "@/lib/finance/helpers";
import { FIX } from "./fixture";

test("cagr basic", () => {
  expect(cagr(121, 100, 2)!).toBeCloseTo(0.1, 10);
  expect(cagr(100, 0, 2)).toBeNull();
});

test("median odd/even", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 2, 3, 4])).toBe(2.5);
});

test("linearBand forward, reverse, clamps", () => {
  expect(linearBand(0.1, 0, 0.2)).toBe(50);
  expect(linearBand(2.5, 2, 0.3)).toBeCloseTo((2.5 - 2) / (0.3 - 2) * 100, 6); // reversed
  expect(linearBand(99, 0, 10)).toBe(100);
});

test("coefVar of constant series is 0", () => {
  expect(coefVar([5, 5, 5])).toBe(0);
});

test("auto growth = 10% for fixture (all series grow 10%)", () => {
  expect(autoNormalGrowth(FIX)).toBeCloseTo(0.1, 3);
});

test("auto wacc = rf + beta*5% = 0.04 + 1.2*0.05 = 0.10", () => {
  expect(autoWacc(FIX)).toBeCloseTo(0.1, 10);
});

test("resolveAssumptions applies overrides", () => {
  const a = resolveAssumptions(FIX, { wacc: 0.15 });
  expect(a.wacc).toBe(0.15);
  expect(a.terminalGrowth).toBe(0.03);
  expect(a.hHalfLife).toBe(4);
});
```

- [ ] **Step 2: Run to verify fail** — `npm test` → FAIL (modules missing).
- [ ] **Step 3: Create the three lib files exactly as specified in Interfaces above.**
- [ ] **Step 4: Run tests** — `npm test` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: finance types, helpers, auto assumptions"`.

---

### Task 4: Valuation engine — 10 models + composite

**Files:**
- Create: `lib/finance/valuation.ts`
- Test: `tests/valuation.test.ts`

**Interfaces:**
- Consumes: types/helpers/assumptions from Task 3.
- Produces: `computeValuation(s: FinancialSnapshot, overrides?: Partial<Assumptions>): ValuationOutput`.

- [ ] **Step 1: Write failing tests** — `tests/valuation.test.ts`. Key analytic checks: with growth 0 everywhere and wacc 10%, a 20-yr fading DCF + Gordon terminal equals a flat perpetuity = base/0.10 exactly.

```ts
import { expect, test } from "vitest";
import { computeValuation } from "@/lib/finance/valuation";
import { FIX } from "./fixture";

const ZERO_G = { normalGrowth: 0, terminalGrowth: 0, wacc: 0.1, marginExpansion: 0, hHalfLife: 4 };

function model(out: ReturnType<typeof computeValuation>, key: string) {
  const m = out.models.find((m) => m.key === key)!;
  expect(m, key).toBeDefined();
  return m;
}

test("DCF-20 zero-growth = perpetuity: (opCF/wacc + cash - debt)/shares", () => {
  const out = computeValuation(FIX, ZERO_G);
  // 300/0.1 = 3000; +200 cash -400 debt = 2800; /100 shares = 28
  expect(model(out, "dcf20").value!).toBeCloseTo(28, 6);
});

test("DFCF-20 zero-growth: (250/0.1 + 200 - 400)/100 = 23", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "dfcf20").value!).toBeCloseTo(23, 6);
});

test("DNI-20 zero-growth: 200/0.1/100 = 20 (no debt adj)", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "dni20").value!).toBeCloseTo(20, 6);
});

test("H-model zero-growth: FCF/wacc/shares = 25", () => {
  const out = computeValuation(FIX, ZERO_G);
  expect(model(out, "hmodel").value!).toBeCloseTo(25, 6);
});

test("PEG-implied: EPS 2 * min(g*100,30) with g=10% → 2*10 = 20", () => {
  const out = computeValuation(FIX, { ...ZERO_G, normalGrowth: 0.1 });
  expect(model(out, "peg").value!).toBeCloseTo(20, 6);
});

test("Graham: EPS*(8.5+2g)*4.4/Y, g=10, Y=(0.04+0.01)*100=5 → 2*28.5*4.4/5 = 50.16", () => {
  const out = computeValuation(FIX, { ...ZERO_G, normalGrowth: 0.1 });
  expect(model(out, "graham").value!).toBeCloseTo(50.16, 2);
});

test("EV/EBITDA uses median historical multiple", () => {
  // fixture: every year mktcap = 40f*100 = 4000f, debt 400, cash 200, ebitda 350f
  // multiple_f = (4000f + 200)/... careful: EV_t = cap_t + debt - cash = 4000f + 200
  // ratio_t = (4000f+200)/(350f). For f=1: 4200/350 = 12; f=1/1.1: (3636.36+200)/318.18 = 12.057...
  // With varying f the ratios differ slightly; assert value = medianMultiple*350 - 400 + 200, /100
  const out = computeValuation(FIX, ZERO_G);
  const v = model(out, "evEbitda").value!;
  expect(v).toBeGreaterThan(35); // ~ (12.1*350 - 200)/100 ≈ 40.3
  expect(v).toBeLessThan(45);
});

test("terminal growth >= wacc → DCF models null with note", () => {
  const out = computeValuation(FIX, { ...ZERO_G, terminalGrowth: 0.12, wacc: 0.1 });
  expect(model(out, "dcf20").value).toBeNull();
  expect(model(out, "dcf20").note).toMatch(/terminal/i);
});

test("negative base CF → null with note", () => {
  const bad = structuredClone(FIX);
  bad.years[0].operatingCashFlow = -50;
  const out = computeValuation(bad, ZERO_G);
  expect(model(out, "dcf20").value).toBeNull();
});

test("composite = trimmed mean of valid models, needs >= 5", () => {
  const out = computeValuation(FIX, ZERO_G);
  const vals = out.models.map((m) => m.value).filter((v): v is number => v !== null);
  expect(vals.length).toBeGreaterThanOrEqual(5);
  const sorted = [...vals].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  const expected = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  expect(out.composite!).toBeCloseTo(expected, 6);
  expect(out.range!.min).toBeCloseTo(sorted[0], 6);
  expect(out.range!.max).toBeCloseTo(sorted[sorted.length - 1], 6);
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — `lib/finance/valuation.ts` (complete file):

```ts
import { Assumptions, FinancialSnapshot, ModelResult, ValuationOutput } from "./types";
import { autoNormalGrowth, autoWacc, resolveAssumptions } from "./assumptions";
import { clamp, median } from "./helpers";

const HORIZON = 20;

// growth fades linearly from g0 (year 1) to gT (year 20)
function fadePath(g0: number, gT: number): number[] {
  return Array.from(
    { length: HORIZON },
    (_, i) => g0 + ((gT - g0) * i) / (HORIZON - 1)
  );
}

// PV of 20 years of flows grown along fade path + Gordon terminal value
function discountedSeries(base: number, a: Assumptions): number | null {
  if (a.wacc <= a.terminalGrowth) return null;
  let cf = base;
  let pv = 0;
  fadePath(a.normalGrowth, a.terminalGrowth).forEach((g, i) => {
    cf *= 1 + g;
    pv += cf / Math.pow(1 + a.wacc, i + 1);
  });
  const tv = (cf * (1 + a.terminalGrowth)) / (a.wacc - a.terminalGrowth);
  return pv + tv / Math.pow(1 + a.wacc, HORIZON);
}

type Ctx = { s: FinancialSnapshot; a: Assumptions };

function latest(s: FinancialSnapshot) {
  return s.years[0];
}

function perShare(equity: number, s: FinancialSnapshot): number {
  return equity / s.sharesOutstanding;
}

const TERM_NOTE = "n/a — terminal growth must be below WACC";

// ---- DCF family -----------------------------------------------------------

function dcfModel(
  base: number | null,
  label: string,
  ctx: Ctx,
  adjustNetDebt: boolean
): { value: number | null; note?: string } {
  if (base === null) return { value: null, note: `n/a — missing ${label}` };
  if (base <= 0) return { value: null, note: `n/a — negative ${label}` };
  const pv = discountedSeries(base, ctx.a);
  if (pv === null) return { value: null, note: TERM_NOTE };
  const y = latest(ctx.s);
  const adj = adjustNetDebt ? (y.cash ?? 0) - (y.totalDebt ?? 0) : 0;
  return { value: perShare(pv + adj, ctx.s) };
}

// ---- historical multiples -------------------------------------------------

// per-year: EV_t = yearEndPrice*shares + debt - cash; returns median of metric ratios
function medianMultiple(
  s: FinancialSnapshot,
  metric: (y: FinancialSnapshot["years"][number]) => number | null,
  useEV: boolean
): number | null {
  const ratios: number[] = [];
  for (const y of s.years) {
    const m = metric(y);
    const shares = y.sharesOutstanding ?? s.sharesOutstanding;
    if (m === null || m <= 0 || y.yearEndPrice === null || !shares) continue;
    const cap = y.yearEndPrice * shares;
    const val = useEV ? cap + (y.totalDebt ?? 0) - (y.cash ?? 0) : cap;
    if (val > 0) ratios.push(val / m);
  }
  return median(ratios);
}

function multipleModel(
  s: FinancialSnapshot,
  metric: (y: FinancialSnapshot["years"][number]) => number | null,
  label: string,
  useEV: boolean
): { value: number | null; note?: string } {
  const m0 = metric(latest(s));
  if (m0 === null || m0 <= 0)
    return { value: null, note: `n/a — missing/negative ${label}` };
  const mult = medianMultiple(s, metric, useEV);
  if (mult === null)
    return { value: null, note: "n/a — no price history for own multiple" };
  const y = latest(s);
  const fair = useEV ? mult * m0 - (y.totalDebt ?? 0) + (y.cash ?? 0) : mult * m0;
  return { value: perShare(fair, s) };
}

// ---- main -----------------------------------------------------------------

export function computeValuation(
  s: FinancialSnapshot,
  overrides: Partial<Assumptions> = {}
): ValuationOutput {
  const a = resolveAssumptions(s, overrides);
  const y = latest(s);
  const models: ModelResult[] = [];
  const add = (
    key: string,
    name: string,
    variant: string,
    r: { value: number | null; note?: string }
  ) => models.push({ key, name, variant, ...r });

  const ctx = { s, a };

  add("dcf20", "DCF-20", "20Y · Operating CF", dcfModel(y.operatingCashFlow, "operating cash flow", ctx, true));
  add("dfcf20", "DFCF-20", "20Y · Free CF", dcfModel(y.freeCashFlow, "free cash flow", ctx, true));
  add("dni20", "DNI-20", "20Y · Net Income", dcfModel(y.netIncome, "net income", ctx, false));

  // H-model: V = FCF0 * [(1+gT) + H*(g0-gT)] / (wacc - gT)
  {
    const fcf = y.freeCashFlow;
    if (fcf === null || fcf <= 0)
      add("hmodel", "H-Model DCF", "Intrinsic", { value: null, note: "n/a — negative/missing FCF" });
    else if (a.wacc <= a.terminalGrowth)
      add("hmodel", "H-Model DCF", "Intrinsic", { value: null, note: TERM_NOTE });
    else {
      const v =
        (fcf * (1 + a.terminalGrowth + a.hHalfLife * (a.normalGrowth - a.terminalGrowth))) /
        (a.wacc - a.terminalGrowth);
      add("hmodel", "H-Model DCF", "Intrinsic", { value: perShare(v, s) });
    }
  }

  add("evEbitda", "EV / EBITDA", "Multiples", multipleModel(s, (yy) => yy.ebitda, "EBITDA", true));
  add("evRevenue", "EV / Revenue", "Multiples", multipleModel(s, (yy) => yy.revenue, "revenue", true));
  add("pFcf", "P / FCF", "Multiples", multipleModel(s, (yy) => yy.freeCashFlow, "free cash flow", false));

  // Revenue DCF: project revenue on fade path; margin_t = min(m0 + mExp*t, m0+0.10)
  {
    const rev = y.revenue;
    const ni = y.netIncome;
    if (rev === null || rev <= 0 || ni === null)
      add("revDcf", "Revenue DCF", "Growth", { value: null, note: "n/a — missing revenue/net income" });
    else if (a.wacc <= a.terminalGrowth)
      add("revDcf", "Revenue DCF", "Growth", { value: null, note: TERM_NOTE });
    else {
      const m0 = ni / rev;
      let r = rev;
      let pv = 0;
      let lastNI = 0;
      fadePath(a.normalGrowth, a.terminalGrowth).forEach((g, i) => {
        r *= 1 + g;
        const m = Math.min(m0 + a.marginExpansion * (i + 1), m0 + 0.1);
        lastNI = r * m;
        pv += lastNI / Math.pow(1 + a.wacc, i + 1);
      });
      const tv = (lastNI * (1 + a.terminalGrowth)) / (a.wacc - a.terminalGrowth);
      pv += tv / Math.pow(1 + a.wacc, HORIZON);
      if (pv <= 0)
        add("revDcf", "Revenue DCF", "Growth", { value: null, note: "n/a — negative projected earnings" });
      else add("revDcf", "Revenue DCF", "Growth", { value: perShare(pv, s) });
    }
  }

  // PEG-implied: fair P/E = growth% (PEG = 1), growth capped at 30
  {
    const eps = s.trailingEPS;
    if (eps === null || eps <= 0)
      add("peg", "PEG-implied", "Growth", { value: null, note: "n/a — negative/missing EPS" });
    else if (a.normalGrowth <= 0)
      add("peg", "PEG-implied", "Growth", { value: null, note: "n/a — no growth" });
    else {
      const g100 = clamp(a.normalGrowth * 100, 0, 30);
      add("peg", "PEG-implied", "Growth", { value: eps * g100 });
    }
  }

  // Graham revised: V = EPS * (8.5 + 2g) * 4.4 / Y ; g capped 25; Y = AAA yield % ≈ (rf+1pp)*100
  {
    const eps = s.trailingEPS;
    if (eps === null || eps <= 0)
      add("graham", "Graham Revised", "EPS × growth", { value: null, note: "n/a — negative/missing EPS" });
    else {
      const g100 = clamp(a.normalGrowth * 100, 0, 25);
      const Y = (s.riskFreeRate + 0.01) * 100;
      add("graham", "Graham Revised", "EPS × growth", {
        value: (eps * (8.5 + 2 * g100) * 4.4) / Y,
      });
    }
  }

  // Composite: trimmed mean (drop single min & max), needs >= 5 valid
  const valid = models.map((m) => m.value).filter((v): v is number => v !== null);
  let composite: number | null = null;
  let range: ValuationOutput["range"] = null;
  if (valid.length >= 5) {
    const sorted = [...valid].sort((x, z) => x - z);
    const trimmed = sorted.slice(1, -1);
    composite = trimmed.reduce((x, z) => x + z, 0) / trimmed.length;
    range = { min: sorted[0], max: sorted[sorted.length - 1] };
  }

  return {
    models,
    composite,
    range,
    assumptions: a,
    autoNormalGrowth: autoNormalGrowth(s),
    autoWacc: autoWacc(s),
  };
}
```

- [ ] **Step 4: Run tests** — `npm test` → all pass. If EV/EBITDA bounds fail, print the actual value and verify by hand against the fixture before changing the assertion.
- [ ] **Step 5: Commit** — `git commit -m "feat: valuation engine, 10 models + trimmed-mean composite"`.

---

### Task 5: Grading engine — 6 dimensions + letters

**Files:**
- Create: `lib/finance/grading.ts`
- Test: `tests/grading.test.ts`

**Interfaces:**
- Consumes: `FinancialSnapshot`, `QualityOutput`, helpers, and `composite` (pass the composite fair value in).
- Produces: `computeQuality(s: FinancialSnapshot, compositeFairValue: number | null): QualityOutput`, `toGrade(score: number): Grade`.

- [ ] **Step 1: Write failing tests** — `tests/grading.test.ts`:

```ts
import { expect, test } from "vitest";
import { computeQuality, toGrade } from "@/lib/finance/grading";
import { FIX } from "./fixture";

test("grade boundaries", () => {
  expect(toGrade(95)).toBe("A");
  expect(toGrade(90)).toBe("A");
  expect(toGrade(85)).toBe("B+");
  expect(toGrade(75)).toBe("B");
  expect(toGrade(65)).toBe("C+");
  expect(toGrade(55)).toBe("C");
  expect(toGrade(40)).toBe("D");
  expect(toGrade(10)).toBe("F");
});

test("fixture profitability score is high (margins 20%/28%, ROE 20%, ROIC>15%)", () => {
  const q = computeQuality(FIX, 40);
  const p = q.dimensions.find((d) => d.key === "profitability")!;
  // netMargin 20% → 100; opMargin 28% → 100; ROE 200/1000=20% → 100;
  // ROIC = 280*0.79/(1000+400-200) = 221.2/1200 = 18.4% → 100. All 100.
  expect(p.score!).toBeGreaterThan(95);
});

test("valuation dimension: fair value == price → ~50", () => {
  const q = computeQuality(FIX, 40); // upside 0 → upside score 50
  const v = q.dimensions.find((d) => d.key === "valuation")!;
  expect(v.score!).toBeGreaterThan(30);
  expect(v.score!).toBeLessThan(70);
});

test("all six dimensions present and overall computed", () => {
  const q = computeQuality(FIX, 50);
  expect(q.dimensions.map((d) => d.key).sort()).toEqual(
    ["finStrength", "growth", "moat", "predictability", "profitability", "valuation"].sort()
  );
  expect(q.overallScore).not.toBeNull();
  expect(q.overallGrade).not.toBeNull();
});

test("null composite → valuation dimension null, overall still computed from rest", () => {
  const q = computeQuality(FIX, null);
  const v = q.dimensions.find((d) => d.key === "valuation")!;
  expect(v.score).toBeNull();
  expect(q.overallScore).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — `lib/finance/grading.ts` (complete file):

```ts
import { FinancialSnapshot, QualityOutput, DimensionScore, Grade } from "./types";
import { linearBand, mean, coefVar, seriesOldestFirst, cagr, clamp } from "./helpers";

// All thresholds in one place — tune here.
export const GRADING_BANDS = {
  netMargin: [0, 0.2],
  opMargin: [0, 0.25],
  roe: [0, 0.2],
  roic: [0, 0.15],
  debtToEquity: [2, 0.3], // reversed
  interestCoverage: [1.5, 10],
  currentRatio: [1, 2],
  debtPaybackYears: [8, 2], // reversed
  growthCagrFloor: 30, // 0% CAGR → 30 pts, 15% → 100
  growthCagrTop: 0.15,
  cv: [0.5, 0.05], // reversed: choppy → 0, steady → 100
  grossMargin: [0.1, 0.4],
  grossMarginCv: [0.3, 0.02], // reversed
  roicMoatFloor: 0.12,
  upside: [-0.3, 0.3],
  peVsMedian: [1.5, 0.5], // reversed: PE at 1.5x own median → 0, at 0.5x → 100
  taxRate: 0.21,
} as const;

export function toGrade(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B+";
  if (score >= 70) return "B";
  if (score >= 60) return "C+";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

const B = GRADING_BANDS;

function dim(key: string, name: string, subs: (number | null)[], detail: string): DimensionScore {
  const valid = subs.filter((x): x is number => x !== null);
  const score = valid.length ? mean(valid) : null;
  return { key, name, score, grade: score === null ? null : toGrade(score), detail };
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function computeQuality(
  s: FinancialSnapshot,
  compositeFairValue: number | null
): QualityOutput {
  const y = s.years[0];
  const dims: DimensionScore[] = [];

  // --- Profitability
  const netMargin = y.revenue && y.netIncome !== null ? y.netIncome / y.revenue : null;
  const opMargin = y.revenue && y.operatingIncome !== null ? y.operatingIncome / y.revenue : null;
  const roe = y.equity && y.netIncome !== null ? y.netIncome / y.equity : null;
  const investedCapital =
    y.equity !== null ? y.equity + (y.totalDebt ?? 0) - (y.cash ?? 0) : null;
  const roic =
    investedCapital && investedCapital > 0 && y.operatingIncome !== null
      ? (y.operatingIncome * (1 - B.taxRate)) / investedCapital
      : null;
  dims.push(
    dim(
      "profitability",
      "Profitability",
      [
        netMargin === null ? null : linearBand(netMargin, ...B.netMargin),
        opMargin === null ? null : linearBand(opMargin, ...B.opMargin),
        roe === null ? null : linearBand(roe, ...B.roe),
        roic === null ? null : linearBand(roic, ...B.roic),
      ],
      `Net margin ${pct(netMargin)}, ROE ${pct(roe)}, ROIC ${pct(roic)}`
    )
  );

  // --- Financial strength
  const dte = y.equity && y.equity > 0 && y.totalDebt !== null ? y.totalDebt / y.equity : null;
  const cov =
    y.interestExpense && y.interestExpense > 0 && y.operatingIncome !== null
      ? y.operatingIncome / y.interestExpense
      : y.operatingIncome !== null && y.operatingIncome > 0
      ? 999 // no interest expense = effectively infinite coverage
      : null;
  const cr =
    y.currentLiabilities && y.currentLiabilities > 0 && y.currentAssets !== null
      ? y.currentAssets / y.currentLiabilities
      : null;
  const netDebt = y.totalDebt !== null ? y.totalDebt - (y.cash ?? 0) : null;
  const payback =
    netDebt === null
      ? null
      : netDebt <= 0
      ? 100 // net cash
      : y.freeCashFlow && y.freeCashFlow > 0
      ? linearBand(netDebt / y.freeCashFlow, ...B.debtPaybackYears)
      : 0;
  dims.push(
    dim(
      "finStrength",
      "Financial strength",
      [
        dte === null ? null : linearBand(dte, ...B.debtToEquity),
        cov === null ? null : linearBand(cov, ...B.interestCoverage),
        cr === null ? null : linearBand(cr, ...B.currentRatio),
        payback,
      ],
      `Debt/equity ${dte?.toFixed(2) ?? "n/a"}, coverage ${cov === null ? "n/a" : cov >= 999 ? "∞" : cov.toFixed(1) + "×"}`
    )
  );

  // --- Predictability
  const revs = seriesOldestFirst(s.years, (yy) => yy.revenue);
  const revGrowths = revs.slice(1).map((r, i) => r / revs[i] - 1);
  const margins = seriesOldestFirst(s.years, (yy) =>
    yy.revenue && yy.netIncome !== null ? yy.netIncome / yy.revenue : null
  );
  const fcfs = seriesOldestFirst(s.years, (yy) => yy.freeCashFlow);
  const revCv = coefVar(revGrowths);
  const marginCv = coefVar(margins);
  const posRev = revGrowths.length ? revGrowths.filter((g) => g > 0).length / revGrowths.length : null;
  const posFcf = fcfs.length ? fcfs.filter((f) => f > 0).length / fcfs.length : null;
  dims.push(
    dim(
      "predictability",
      "Predictability",
      [
        revCv === null ? null : linearBand(revCv, ...B.cv),
        marginCv === null ? null : linearBand(marginCv, ...B.cv),
        posRev === null ? null : posRev * 100,
        posFcf === null ? null : posFcf * 100,
      ],
      `Revenue growth stability, margin stability over ${s.years.length} yrs`
    )
  );

  // --- Growth quality
  const growthScore = (g: number | null): number | null =>
    g === null ? null : g <= 0 ? 0 : B.growthCagrFloor + linearBand(g, 0, B.growthCagrTop) * ((100 - B.growthCagrFloor) / 100);
  const nis = seriesOldestFirst(s.years, (yy) => yy.netIncome);
  const revC = revs.length >= 2 ? cagr(revs[revs.length - 1], revs[0], revs.length - 1) : null;
  const epsC = nis.length >= 2 ? cagr(nis[nis.length - 1], nis[0], nis.length - 1) : null;
  const fcfC = fcfs.length >= 2 ? cagr(fcfs[fcfs.length - 1], fcfs[0], fcfs.length - 1) : null;
  const shares = seriesOldestFirst(s.years, (yy) => yy.sharesOutstanding);
  const shareC = shares.length >= 2 ? cagr(shares[shares.length - 1], shares[0], shares.length - 1) : null;
  let bonus = 0;
  if (epsC !== null && revC !== null && epsC >= revC) bonus += 10;
  if (shareC !== null && shareC > 0.03) bonus -= 10;
  const gSubs = [growthScore(revC), growthScore(epsC), growthScore(fcfC)];
  const gValid = gSubs.filter((x): x is number => x !== null);
  const gScore = gValid.length ? clamp(gValid.reduce((a, b) => a + b, 0) / gValid.length + bonus, 0, 100) : null;
  dims.push({
    key: "growth",
    name: "Growth quality",
    score: gScore,
    grade: gScore === null ? null : toGrade(gScore),
    detail: `Revenue CAGR ${pct(revC)}, EPS CAGR ${pct(epsC)}`,
  });

  // --- Economic moat (quantitative proxy)
  const gms = seriesOldestFirst(s.years, (yy) =>
    yy.revenue && yy.grossProfit !== null ? yy.grossProfit / yy.revenue : null
  );
  const gm0 = gms.length ? gms[gms.length - 1] : null;
  const gmCv = coefVar(gms);
  const roics = s.years
    .map((yy) => {
      const ic = yy.equity !== null ? yy.equity + (yy.totalDebt ?? 0) - (yy.cash ?? 0) : null;
      return ic && ic > 0 && yy.operatingIncome !== null
        ? (yy.operatingIncome * (1 - B.taxRate)) / ic
        : null;
    })
    .filter((v): v is number => v !== null);
  const roicYears = roics.length ? roics.filter((r) => r >= B.roicMoatFloor).length / roics.length : null;
  dims.push(
    dim(
      "moat",
      "Economic moat",
      [
        gm0 === null ? null : linearBand(gm0, ...B.grossMargin),
        gmCv === null ? null : linearBand(gmCv, ...B.grossMarginCv),
        roicYears === null ? null : roicYears * 100,
      ],
      `Gross margin ${pct(gm0)} (quantitative proxy)`
    )
  );

  // --- Valuation
  let vScore: number | null = null;
  if (compositeFairValue !== null && s.price > 0) {
    const upside = compositeFairValue / s.price - 1;
    const upsideScore = linearBand(upside, ...B.upside);
    // blend 70/30 with current PE vs own historical median PE (below median = better)
    const pes = s.years
      .map((yy) => {
        const sh = yy.sharesOutstanding ?? s.sharesOutstanding;
        return yy.yearEndPrice !== null && yy.netIncome && yy.netIncome > 0 && sh
          ? (yy.yearEndPrice * sh) / yy.netIncome
          : null;
      })
      .filter((v): v is number => v !== null);
    const medPe = pes.length ? [...pes].sort((a, b) => a - b)[Math.floor(pes.length / 2)] : null;
    const curPe = s.trailingEPS && s.trailingEPS > 0 ? s.price / s.trailingEPS : null;
    if (medPe && curPe) {
      vScore = 0.7 * upsideScore + 0.3 * linearBand(curPe / medPe, ...B.peVsMedian);
    } else {
      vScore = upsideScore;
    }
  }
  dims.push({
    key: "valuation",
    name: "Valuation",
    score: vScore,
    grade: vScore === null ? null : toGrade(vScore),
    detail:
      compositeFairValue === null
        ? "n/a — composite unavailable"
        : `${pct(compositeFairValue / s.price - 1)} vs fair value`,
  });

  // --- Overall: weighted mean over non-null dims (weights renormalized)
  const WEIGHTS: Record<string, number> = {
    profitability: 0.2,
    finStrength: 0.2,
    valuation: 0.2,
    predictability: 0.15,
    growth: 0.15,
    moat: 0.1,
  };
  let wSum = 0;
  let acc = 0;
  for (const d of dims) {
    if (d.score !== null) {
      acc += d.score * WEIGHTS[d.key];
      wSum += WEIGHTS[d.key];
    }
  }
  const overallScore = wSum > 0 ? acc / wSum : null;
  return {
    dimensions: dims,
    overallScore,
    overallGrade: overallScore === null ? null : toGrade(overallScore),
  };
}
```

- [ ] **Step 4: Run tests** — `npm test` → all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: 6-dimension quality grading engine"`.

---

### Task 6: Yahoo data layer + cached stock bundle

**Files:**
- Create: `lib/data/yahoo.ts`, `lib/data/getStockData.ts`
- Test: `tests/yahoo.test.ts` (normalization only, with an inline fake raw payload — no network in tests)

**Interfaces:**
- Consumes: `cacheGet/cacheSet` (Task 2), finance modules (Tasks 3–5).
- Produces:
  - `yahoo.ts`: `fetchSnapshot(ticker: string): Promise<FinancialSnapshot>` (network) and `normalizeSnapshot(raw: RawBundle, ticker: string): FinancialSnapshot` (pure, tested). `export interface RawBundle { qs: any; chartQuotes: { date: string; close: number | null }[]; riskFree: number }`.
  - `getStockData.ts`: `getStockBundle(ticker: string): Promise<StockBundle>` where `StockBundle = { snapshot: FinancialSnapshot; valuation: ValuationOutput; quality: QualityOutput }`. Cached 24h under key `stock:{TICKER}`. Throws `Error("TICKER_NOT_FOUND")` for unknown tickers.

- [ ] **Step 1: Write failing normalization test** — `tests/yahoo.test.ts`:

```ts
import { expect, test } from "vitest";
import { normalizeSnapshot, RawBundle } from "@/lib/data/yahoo";

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
});

test("missing statements → empty years, still returns snapshot", () => {
  const s = normalizeSnapshot(
    { ...raw, qs: { ...raw.qs, incomeStatementHistory: undefined } },
    "ACME"
  );
  expect(s.years).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement `lib/data/yahoo.ts`:**

```ts
import yahooFinance from "yahoo-finance2";
import { FinancialSnapshot, YearData } from "@/lib/finance/types";

export interface RawBundle {
  qs: any;
  chartQuotes: { date: string; close: number | null }[];
  riskFree: number;
}

const num = (v: any): number | null => {
  // yahoo-finance2 returns numbers or {raw: n} depending on version/module
  const n = typeof v === "object" && v !== null ? v.raw : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const abs = (v: number | null): number | null => (v === null ? null : Math.abs(v));

function closeNearest(quotes: RawBundle["chartQuotes"], target: Date): number | null {
  let best: number | null = null;
  let bestDiff = Infinity;
  for (const q of quotes) {
    if (q.close === null) continue;
    const diff = Math.abs(new Date(q.date).getTime() - target.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = q.close;
    }
  }
  // only accept a close within ~60 days of the fiscal year end
  return bestDiff <= 60 * 86400_000 ? best : null;
}

export function normalizeSnapshot(raw: RawBundle, ticker: string): FinancialSnapshot {
  const { qs } = raw;
  const income: any[] = qs.incomeStatementHistory?.incomeStatementHistory ?? [];
  const balance: any[] = qs.balanceSheetHistory?.balanceSheetStatements ?? [];
  const cashflow: any[] = qs.cashflowStatementHistory?.cashflowStatements ?? [];

  const byYear = (rows: any[]) => {
    const m = new Map<number, any>();
    for (const r of rows) {
      const d = r.endDate ? new Date(r.endDate) : null;
      if (d) m.set(d.getUTCFullYear(), { ...r, _end: d });
    }
    return m;
  };
  const incomeBy = byYear(income);
  const balanceBy = byYear(balance);
  const cashBy = byYear(cashflow);

  const years: YearData[] = [...incomeBy.keys()]
    .sort((a, b) => b - a) // newest first
    .map((year) => {
      const inc = incomeBy.get(year) ?? {};
      const bal = balanceBy.get(year) ?? {};
      const cf = cashBy.get(year) ?? {};
      const opInc = num(inc.operatingIncome);
      const dep = num(cf.depreciation);
      const ocf = num(cf.totalCashFromOperatingActivities);
      const capex = abs(num(cf.capitalExpenditures));
      const debt = (num(bal.shortLongTermDebt) ?? 0) + (num(bal.longTermDebt) ?? 0);
      const cash = (num(bal.cash) ?? 0) + (num(bal.shortTermInvestments) ?? 0);
      return {
        year,
        revenue: num(inc.totalRevenue),
        grossProfit: num(inc.grossProfit),
        operatingIncome: opInc,
        netIncome: num(inc.netIncome),
        ebitda: opInc !== null && dep !== null ? opInc + dep : opInc,
        operatingCashFlow: ocf,
        capex,
        freeCashFlow: ocf !== null && capex !== null ? ocf - capex : null,
        totalDebt: num(bal.shortLongTermDebt) !== null || num(bal.longTermDebt) !== null ? debt : null,
        cash: num(bal.cash) !== null || num(bal.shortTermInvestments) !== null ? cash : null,
        equity: num(bal.totalStockholderEquity),
        currentAssets: num(bal.totalCurrentAssets),
        currentLiabilities: num(bal.totalCurrentLiabilities),
        interestExpense: abs(num(inc.interestExpense)),
        sharesOutstanding: num(qs.defaultKeyStatistics?.sharesOutstanding),
        yearEndPrice: closeNearest(raw.chartQuotes, inc._end ?? new Date(`${year}-12-31`)),
      };
    });

  // Latest year: prefer financialData current debt/cash (more complete)
  if (years[0]) {
    const fdDebt = num(qs.financialData?.totalDebt);
    const fdCash = num(qs.financialData?.totalCash);
    if (fdDebt !== null) years[0].totalDebt = fdDebt;
    if (fdCash !== null) years[0].cash = fdCash;
  }

  const price = num(qs.price?.regularMarketPrice);
  const shares = num(qs.defaultKeyStatistics?.sharesOutstanding);
  if (price === null || shares === null || shares <= 0) {
    throw new Error("TICKER_NOT_FOUND");
  }

  return {
    ticker: ticker.toUpperCase(),
    name: qs.price?.longName ?? qs.price?.shortName ?? ticker.toUpperCase(),
    currency: qs.price?.currency ?? "USD",
    price,
    marketCap: num(qs.price?.marketCap),
    sharesOutstanding: shares,
    beta: num(qs.defaultKeyStatistics?.beta),
    trailingEPS: num(qs.defaultKeyStatistics?.trailingEps),
    riskFreeRate: raw.riskFree,
    years,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchSnapshot(ticker: string): Promise<FinancialSnapshot> {
  let qs: any;
  try {
    qs = await yahooFinance.quoteSummary(ticker, {
      modules: [
        "price",
        "summaryDetail",
        "defaultKeyStatistics",
        "financialData",
        "incomeStatementHistory",
        "balanceSheetHistory",
        "cashflowStatementHistory",
      ],
    });
  } catch {
    throw new Error("TICKER_NOT_FOUND");
  }

  // 5y monthly closes for historical multiples
  let chartQuotes: RawBundle["chartQuotes"] = [];
  try {
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 6);
    const chart = await yahooFinance.chart(ticker, { period1, interval: "1mo" });
    chartQuotes = (chart.quotes ?? []).map((q: any) => ({
      date: new Date(q.date).toISOString(),
      close: typeof q.close === "number" ? q.close : null,
    }));
  } catch {
    /* multiples models will show n/a */
  }

  // 10-yr treasury via ^TNX; yahoo reports the yield directly (e.g. 4.4)
  let riskFree = 0.042;
  try {
    const tnx: any = await yahooFinance.quote("^TNX");
    const v = tnx?.regularMarketPrice;
    if (typeof v === "number" && v > 0) riskFree = v > 1 ? v / 100 : v;
  } catch {
    /* keep default */
  }

  return normalizeSnapshot({ qs, chartQuotes, riskFree }, ticker);
}
```

- [ ] **Step 4: Implement `lib/data/getStockData.ts`:**

```ts
import { cacheGet, cacheSet } from "@/lib/db";
import { fetchSnapshot } from "./yahoo";
import { computeValuation } from "@/lib/finance/valuation";
import { computeQuality } from "@/lib/finance/grading";
import { FinancialSnapshot, ValuationOutput, QualityOutput } from "@/lib/finance/types";

export interface StockBundle {
  snapshot: FinancialSnapshot;
  valuation: ValuationOutput;
  quality: QualityOutput;
}

const TTL_24H = 24 * 3600;

export async function getStockBundle(ticker: string, force = false): Promise<StockBundle> {
  const key = `stock:${ticker.toUpperCase()}`;
  if (!force) {
    const hit = cacheGet<StockBundle>(key);
    if (hit) return hit;
  }
  const snapshot = await fetchSnapshot(ticker);
  const valuation = computeValuation(snapshot);
  const quality = computeQuality(snapshot, valuation.composite);
  const bundle = { snapshot, valuation, quality };
  cacheSet(key, bundle, TTL_24H);
  return bundle;
}
```

- [ ] **Step 5: Run tests** — `npm test` → all pass (normalization tests only).
- [ ] **Step 6: Live smoke (manual, not in test suite)** — `npx tsx -e "import('./lib/data/getStockData').then(m => m.getStockBundle('AAPL')).then(b => console.log(b.snapshot.name, b.valuation.composite, b.quality.overallGrade))"` (add `tsx` as dev dep if needed). Expected: prints Apple Inc., a finite composite, a letter grade. If yahoo-finance2 field names differ from the normalize mapping (API drift), fix the mapping in `normalizeSnapshot`, not the tests' semantics.
- [ ] **Step 7: Commit** — `git commit -m "feat: yahoo data layer + cached stock bundle"`.

---

### Task 7: Home page + stock layout + Overview page

**Files:**
- Create: `app/page.tsx` (replace scaffold), `app/stock/[ticker]/layout.tsx`, `app/stock/[ticker]/page.tsx`, `components/GradeBadge.tsx`, `components/SignalBadge.tsx`
- Modify: `app/layout.tsx` (title), `app/globals.css` (keep Tailwind base)

**Interfaces:**
- Consumes: `getStockBundle` (Task 6).
- Produces: `fmtMoney(n: number | null, currency?: string): string`, `fmtPct(n: number | null): string` in `lib/format.ts` — used by Tasks 8–10.

- [ ] **Step 1: Create `lib/format.ts`:**

```ts
export function fmtMoney(n: number | null, currency = "USD"): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}
export function fmtBig(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  return n.toFixed(0);
}
export function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}
```

- [ ] **Step 2: Home page `app/page.tsx`** — centered search form:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  async function go(formData: FormData) {
    "use server";
    const t = String(formData.get("ticker") ?? "").trim().toUpperCase();
    if (t) redirect(`/stock/${encodeURIComponent(t)}`);
  }
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">InvestSite</h1>
      <p className="text-neutral-500">Intrinsic value, quality grades & AI research for US stocks</p>
      <form action={go} className="flex gap-2">
        <input
          name="ticker"
          placeholder="Ticker e.g. AAPL"
          className="rounded-lg border border-neutral-300 px-4 py-2 text-lg uppercase focus:outline-none focus:ring"
          autoFocus
        />
        <button className="rounded-lg bg-blue-600 px-5 py-2 text-lg font-medium text-white">
          Analyze
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Stock layout `app/stock/[ticker]/layout.tsx`** — header (name, price, signal) + tab nav (Overview `/stock/T`, Intrinsic Value `/stock/T/value`, Metrics `/stock/T/metrics`, AI Research `/stock/T/research`). Wrap `getStockBundle` in try/catch → `notFound()` on `TICKER_NOT_FOUND`. Create `app/stock/[ticker]/not-found.tsx` with a friendly "ticker not found" message + link home. Tabs are plain `<Link>`s styled with Tailwind; loading skeleton via `app/stock/[ticker]/loading.tsx` (pulsing gray blocks) so first fetch (~2–4s) shows immediately.

```tsx
// app/stock/[ticker]/layout.tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import { fmtMoney, fmtPct } from "@/lib/format";

export default async function StockLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  let bundle;
  try {
    bundle = await getStockBundle(ticker);
  } catch {
    notFound();
  }
  const { snapshot: s, valuation: v } = bundle;
  const upside = v.composite !== null ? v.composite / s.price - 1 : null;
  const tabs = [
    ["Overview", `/stock/${s.ticker}`],
    ["Intrinsic Value", `/stock/${s.ticker}/value`],
    ["Metrics", `/stock/${s.ticker}/metrics`],
    ["AI Research", `/stock/${s.ticker}/research`],
  ] as const;
  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {s.name} <span className="text-neutral-400">({s.ticker})</span>
          </h1>
          <p className="text-lg">
            {fmtMoney(s.price, s.currency)}{" "}
            <span className={upside !== null && upside > 0 ? "text-green-600" : "text-red-600"}>
              {upside !== null ? `${fmtPct(upside)} vs fair value` : ""}
            </span>
          </p>
        </div>
        <nav className="flex gap-1 rounded-lg bg-neutral-100 p-1">
          {tabs.map(([label, href]) => (
            <Link key={href} href={href} className="rounded-md px-3 py-1.5 text-sm hover:bg-white">
              {label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Overview page `app/stock/[ticker]/page.tsx`** — server component: 4 stat cards (Composite fair value, Market price, Implied upside, Method range), signal badge (Undervalued >+15% / Fairly valued ±15% / Overvalued <−15%), verdict line, grid of 6 `GradeBadge` cards (dimension name, letter, detail) + overall grade card. Verdict copy: `"{Quality} business trading {valuation}"` where Quality = overallScore≥70 ? "High-quality" : ≥50 ? "Decent" : "Low-quality"; valuation = signal text ("below fair value" / "near fair value" / "above fair value"). Include `<CompetitorsPanel ticker>` placeholder slot — render a "Competitors" heading with `<div id="competitors" />` comment for Task 10 to fill (do NOT build the panel in this task).

`components/GradeBadge.tsx`:

```tsx
const COLORS: Record<string, string> = {
  A: "bg-green-100 text-green-800",
  "B+": "bg-emerald-100 text-emerald-800",
  B: "bg-lime-100 text-lime-800",
  "C+": "bg-yellow-100 text-yellow-800",
  C: "bg-amber-100 text-amber-800",
  D: "bg-orange-100 text-orange-800",
  F: "bg-red-100 text-red-800",
};
export default function GradeBadge({ grade }: { grade: string | null }) {
  return (
    <span
      className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-lg font-bold ${
        grade ? COLORS[grade] : "bg-neutral-100 text-neutral-400"
      }`}
    >
      {grade ?? "–"}
    </span>
  );
}
```

- [ ] **Step 5: Verify** — `npm run dev`, open `http://localhost:3000`, search AAPL. Expected: header, stats, 6 grades render; `/stock/FAKETICKER123` shows not-found page. `npm test` still green.
- [ ] **Step 6: Commit** — `git commit -m "feat: home search, stock layout, overview page"`.

---

### Task 8: Intrinsic Value page with live knobs

**Files:**
- Create: `app/stock/[ticker]/value/page.tsx` (server: passes snapshot to client), `components/ValueTable.tsx` (client)

**Interfaces:**
- Consumes: `computeValuation` runs CLIENT-SIDE inside `ValueTable` on knob change (this is why lib/finance must stay pure).

- [ ] **Step 1: Server page:**

```tsx
import { getStockBundle } from "@/lib/data/getStockData";
import ValueTable from "@/components/ValueTable";

export default async function ValuePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const { snapshot } = await getStockBundle(ticker);
  return <ValueTable snapshot={snapshot} />;
}
```

- [ ] **Step 2: `components/ValueTable.tsx`** (client). Requirements:
  - `"use client"`; props `{ snapshot: FinancialSnapshot }`.
  - State: `{ normalGrowth?: number; terminalGrowth: number; marginExpansion: number; wacc?: number; hHalfLife: number }` — `undefined` = auto.
  - `const out = useMemo(() => computeValuation(snapshot, overrides), [snapshot, overrides])` where overrides converts UI percentages to decimals (`12` → `0.12`).
  - Table rows per model: name, variant, horizontal bar, value (`fmtMoney`), vs-market %. Bar: a relative `div` scaled so the max of (all model values, price) = 100% width; a vertical tick marks the market price position; bar color: green if value > price*1.05, red if < price*0.95, amber otherwise; the composite row highlighted (blue bar, `bg-blue-50` row).
  - Rows with `value === null` render the `note` in gray italics, no bar.
  - Composite row at bottom + "Method range" and "X of 10 methods" caption.
  - 5 knob inputs at the bottom (grid): Normal growth %, Terminal growth %, Margin expansion %, WACC %, H half-life (yrs). Placeholder shows auto value e.g. `` `${(out.autoNormalGrowth*100).toFixed(1)}% (auto)` ``. Empty input = auto. Inline red text under terminal-growth/WACC inputs when `terminalGrowth >= wacc`: "Terminal growth must be below WACC".
  - Everything numeric parses via `Number(...)`; `NaN` → treat as auto/default.

Bar cell implementation (reference):

```tsx
function Bar({ value, price, max, highlight }: { value: number; price: number; max: number; highlight?: boolean }) {
  const w = Math.max(2, (value / max) * 100);
  const tick = (price / max) * 100;
  const color = highlight
    ? "bg-blue-700"
    : value > price * 1.05
    ? "bg-green-600"
    : value < price * 0.95
    ? "bg-red-500"
    : "bg-amber-500";
  return (
    <div className="relative h-3 w-full rounded bg-neutral-100">
      <div className={`h-3 rounded ${color}`} style={{ width: `${Math.min(w, 100)}%` }} />
      <div className="absolute top-[-3px] h-[18px] w-[2px] bg-neutral-500" style={{ left: `${Math.min(tick, 100)}%` }} />
    </div>
  );
}
```

- [ ] **Step 3: Verify** — dev server: change WACC to 8 → all DCF values rise instantly (no network request — check devtools). Set terminal growth 12 with WACC 10 → DCF rows show n/a note + inline validation. Clear inputs → back to auto.
- [ ] **Step 4: Commit** — `git commit -m "feat: intrinsic value page with live assumption knobs"`.

---

### Task 9: Metrics page

**Files:**
- Create: `app/stock/[ticker]/metrics/page.tsx`, `components/TrendBars.tsx`

**Interfaces:**
- Consumes: `StockBundle.snapshot.years` (newest first — REVERSE to oldest-first for display), `fmtBig`, `fmtPct`.

- [ ] **Step 1: Build the page** — server component. One table, years as columns (oldest → newest). Rows (skip a row entirely if all null): Revenue, Revenue growth YoY, Gross margin, Operating margin, Net margin, Net income, EBITDA, Operating CF, Capex, Free CF, FCF growth YoY, Total debt, Cash, Debt/Equity, Current ratio, Interest coverage, ROE, ROIC, Shares outstanding. Derived values computed inline with the same formulas as grading.ts (margin = x/revenue; ROIC = opInc*(1-0.21)/(equity+debt-cash)). Currency values via `fmtBig`, ratios `toFixed(2)`, percents `fmtPct`.
- [ ] **Step 2: `components/TrendBars.tsx`** — pure-CSS mini bar chart (no recharts):

```tsx
export default function TrendBars({ values, label }: { values: (number | null)[]; label: string }) {
  const nums = values.filter((v): v is number => v !== null);
  const max = Math.max(...nums.map(Math.abs), 1e-9);
  return (
    <div>
      <p className="mb-1 text-sm text-neutral-500">{label}</p>
      <div className="flex h-24 items-end gap-1">
        {values.map((v, i) => (
          <div key={i} className="flex-1">
            <div
              className={v !== null && v < 0 ? "bg-red-400" : "bg-blue-500"}
              style={{ height: `${v === null ? 0 : (Math.abs(v) / max) * 96}px` }}
              title={v === null ? "n/a" : String(v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
```

Render 4 charts above the table: Revenue, Net income, Free CF, Total debt (values oldest→newest).
- [ ] **Step 3: Verify** — dev server AAPL metrics: table renders ~4 year columns, charts sensible, no NaN text anywhere.
- [ ] **Step 4: Commit** — `git commit -m "feat: metrics page with history table and css trend bars"`.

---

### Task 10: Gemini client + competitors (lazy panel)

**Files:**
- Create: `lib/ai/gemini.ts`, `app/api/competitors/[ticker]/route.ts`, `app/api/summary/[ticker]/route.ts`, `components/CompetitorsPanel.tsx`
- Modify: `app/stock/[ticker]/page.tsx` (mount panel)
- Test: `tests/gemini.test.ts` (prompt/parse only, no network)

**Interfaces:**
- Produces:
  - `geminiJSON<T>(prompt: string): Promise<T>` — non-streaming, `responseMimeType: "application/json"`.
  - `geminiStream(prompt: string, opts?: { grounding?: boolean }): Promise<ReadableStream<Uint8Array>>` — raw SSE-derived text chunks (plain text stream, NOT SSE format — just the text deltas).
  - `parseCompetitors(raw: unknown): { ticker: string; name: string }[]` — exported for tests; validates/uppercases/dedupes/limits 5.

- [ ] **Step 1: Failing test** — `tests/gemini.test.ts`:

```ts
import { expect, test } from "vitest";
import { parseCompetitors } from "@/lib/ai/gemini";

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
```

- [ ] **Step 2: Implement `lib/ai/gemini.ts`:**

```ts
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function cfg() {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!key) throw new Error("GEMINI_KEY_MISSING");
  return { key, model };
}

export async function geminiJSON<T>(prompt: string): Promise<T> {
  const { key, model } = cfg();
  const res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) throw new Error(`GEMINI_ERROR_${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  return JSON.parse(text) as T;
}

// Returns a plain-text chunk stream extracted from Gemini's SSE
export async function geminiStream(
  prompt: string,
  opts: { grounding?: boolean } = {}
): Promise<ReadableStream<Uint8Array>> {
  const { key, model } = cfg();
  const body: any = { contents: [{ parts: [{ text: prompt }] }] };
  if (opts.grounding) body.tools = [{ google_search: {} }];
  const res = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse&key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok || !res.body) throw new Error(`GEMINI_ERROR_${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const t = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
          if (t) controller.enqueue(enc.encode(t));
        } catch {
          /* partial line, ignore */
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

export function parseCompetitors(raw: unknown): { ticker: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { ticker: string; name: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = String((item as any).ticker ?? "").trim().toUpperCase();
    const n = String((item as any).name ?? t);
    if (!t || !/^[A-Z.\-]{1,10}$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push({ ticker: t, name: n });
    if (out.length === 5) break;
  }
  return out;
}
```

- [ ] **Step 3: Competitors route `app/api/competitors/[ticker]/route.ts`** — GET; cache key `competitors:{T}` TTL 7 days:

```ts
import { NextResponse } from "next/server";
import { cacheGet, cacheSet } from "@/lib/db";
import { geminiJSON, parseCompetitors } from "@/lib/ai/gemini";

export async function GET(_: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const T = ticker.toUpperCase();
  const key = `competitors:${T}`;
  const hit = cacheGet<{ ticker: string; name: string }[]>(key);
  if (hit) return NextResponse.json({ competitors: hit });
  try {
    const raw = await geminiJSON<unknown>(
      `List the 5 closest publicly listed competitors of the US-listed stock ${T}. ` +
        `US-listed tickers only. Respond ONLY with a JSON array: ` +
        `[{"ticker": "XXX", "name": "Company Name"}]. Do not include ${T} itself.`
    );
    const comps = parseCompetitors(raw);
    if (comps.length) cacheSet(key, comps, 7 * 24 * 3600);
    return NextResponse.json({ competitors: comps });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    const status = msg === "RATE_LIMITED" ? 429 : msg === "GEMINI_KEY_MISSING" ? 503 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
```

- [ ] **Step 4: Summary route `app/api/summary/[ticker]/route.ts`** — GET; returns `{ ticker, name, price, fairValue, upside }` from `getStockBundle` (cached 24h inside); 404 with `{error:"not_found"}` on TICKER_NOT_FOUND.
- [ ] **Step 5: `components/CompetitorsPanel.tsx`** — `"use client"`; on mount (`useEffect`) fetch `/api/competitors/{ticker}`; then for each competitor **sequentially** (`for...of` + `await`, ~300ms gap via `await new Promise(r => setTimeout(r, 300))`) fetch `/api/summary/{t}` and append the row into state. Row: link `/stock/{t}` · name/ticker · fair value · price · colored upside %. Skeleton row while loading; per-row "n/a" on failure; whole panel hidden if competitors call errors (render small gray "Competitors unavailable" text). Mount at bottom of Overview page.
- [ ] **Step 6: Verify** — `npm test` green; dev server AAPL overview → panel appears after main content, rows stream in one by one; second reload instant (cache).
- [ ] **Step 7: Commit** — `git commit -m "feat: gemini client + lazy competitors panel"`.

---

### Task 11: AI Research page (3 streamed reports)

**Files:**
- Create: `lib/ai/prompts.ts`, `app/api/research/route.ts`, `app/stock/[ticker]/research/page.tsx`, `components/ResearchClient.tsx`

**Interfaces:**
- Consumes: `geminiStream`, `getStockBundle`, cache.
- Produces: `buildPrompt(type: ReportType, bundle: StockBundle): { prompt: string; grounding: boolean }` with `type ReportType = "research" | "model3" | "bear"`.

- [ ] **Step 1: `lib/ai/prompts.ts`** — three builders. Each starts with a shared data block:

```ts
import { StockBundle } from "@/lib/data/getStockData";
import { fmtBig } from "@/lib/format";

export type ReportType = "research" | "model3" | "bear";

function dataBlock(b: StockBundle): string {
  const s = b.snapshot;
  const rows = [...s.years].reverse().map((y) =>
    [
      y.year,
      `revenue ${fmtBig(y.revenue)}`,
      `grossProfit ${fmtBig(y.grossProfit)}`,
      `operatingIncome ${fmtBig(y.operatingIncome)}`,
      `netIncome ${fmtBig(y.netIncome)}`,
      `operatingCF ${fmtBig(y.operatingCashFlow)}`,
      `capex ${fmtBig(y.capex)}`,
      `freeCF ${fmtBig(y.freeCashFlow)}`,
      `totalDebt ${fmtBig(y.totalDebt)}`,
      `cash ${fmtBig(y.cash)}`,
      `equity ${fmtBig(y.equity)}`,
    ].join(", ")
  );
  return (
    `VERIFIED FINANCIAL DATA for ${s.name} (${s.ticker}), currency ${s.currency}, ` +
    `current price ${s.price}, market cap ${fmtBig(s.marketCap)}, trailing EPS ${s.trailingEPS}, beta ${s.beta}:\n` +
    rows.join("\n") +
    `\nOur composite intrinsic value estimate: ${b.valuation.composite?.toFixed(2) ?? "n/a"} per share.\n` +
    `Use these numbers as the historical record — do NOT invent different historical figures.\n\n`
  );
}
```

Then, verbatim from the spec/user prompts with placeholders substituted (`{TICKER}`, `{NAME}`, `{SECTOR — derive from name/knowledge}`, `{PRICE}`):
  - `research`: the 7-section report (BUSINESS MODEL, FINANCIAL HEALTH, VALUATION VS PEERS, MACRO & COMPETITIVE ENVIRONMENT, CATALYSTS, RISKS, INVESTMENT THESIS) — generalize all "Reddit/RDDT" references to the ticker. `grounding: true`.
  - `model3`: the 6-step 3-statement model — replace "Pull from SEC filings" with "Use the VERIFIED FINANCIAL DATA above as the historical record; cite it as 'company filings via Yahoo Finance'". Keep [ASSUMPTION] labeling, Bear/Base/Bull scenarios, balance check, Year-5 FCF sensitivity ±3%. `grounding: false`.
  - `bear`: the 7-step bear case — replace hardcoded "75" with `{PRICE}`. `grounding: true`.
  - Every prompt ends with: "Format the entire response as clean Markdown with ## section headings and tables where appropriate."
- [ ] **Step 2: Route `app/api/research/route.ts`** — POST `{ ticker, type }`:
  - Validate type ∈ the 3 values, else 400.
  - Cache key `research:{T}:{type}` TTL 24h. Hit → `new Response(cached, { headers: { "X-Cache": "hit" } })` (plain text, whole body at once).
  - Miss → `getStockBundle`, `buildPrompt`, `geminiStream`. Tee the stream: pipe to the client AND accumulate; on stream end `cacheSet` the full text. Use `stream.tee()` — one branch returned as `new Response(branch1)`, the other read to completion in a detached async loop that writes the cache.
  - 429 from Gemini → 429 JSON `{error: "rate_limited"}`; missing key → 503 `{error:"no_api_key"}`.
- [ ] **Step 3: Research page** — server component checks `process.env.GEMINI_API_KEY`; if unset render explainer ("Add GEMINI_API_KEY to .env.local to enable AI research"). Else render `<ResearchClient ticker>`.
- [ ] **Step 4: `components/ResearchClient.tsx`** — `"use client"`. Three buttons (Full research report / 3-statement model / Bear case) with one-line descriptions. On click: `fetch("/api/research", {method:"POST", body: JSON.stringify({ticker, type})})`, read `res.body` with a reader, append decoded chunks to state; render the accumulating markdown. Markdown rendering: minimal — split on lines; `##`→`<h2>`, `**bold**` via simple replace, `|`-tables rendered as `<pre>`; OR add `react-markdown` (one dep) — implementer's choice, prefer `react-markdown` for tables. Disabled buttons while streaming; error banner for 429 ("Rate limited — try again in a minute") and 503. "Regenerate" button after completion re-posts with `{force:true}` (route: skip cache read when `force`).
- [ ] **Step 5: Verify** — dev server: generate a bear case for AAPL → text streams in live; re-click → instant (cached, X-Cache: hit); check SQLite: `sqlite3 data/cache.db "select key from cache"` shows `research:AAPL:bear`.
- [ ] **Step 6: Commit** — `git commit -m "feat: ai research page with streamed gemini reports"`.

---

### Task 12: End-to-end verification + calibration

**Files:**
- No new files (fixes only, as discovered).

- [ ] **Step 1:** `npm test` — full suite green.
- [ ] **Step 2:** `npm run build` — production build succeeds (catches server/client boundary mistakes).
- [ ] **Step 3:** Manual pass on 3 tickers spanning shapes: `AAPL` (mega-cap, buybacks), `NVDA` (high growth), `F` (low growth, high debt). For each: all 4 pages render, no `NaN`/`undefined` visible, models that can't compute show notes not zeros, grades plausible (F the automaker should NOT out-grade AAPL on financial strength).
- [ ] **Step 4:** Calibration sanity vs the user's screenshot (NVDA-like profile: composite ≈ $234 when price ≈ $205, DNI highest, EV/Revenue lowest): our numbers will differ (different data/thresholds) but check the *shape* — DCF-family above multiples for high-growth names, composite within ±50% of market price for mega-caps. If a model is wildly off (>5× price for AAPL), inspect its inputs before touching formulas.
- [ ] **Step 5:** Knob parity: on `/stock/AAPL/value` set WACC 16.6, terminal 3, H 4 → verify values move in sane directions (higher WACC → lower DCF values).
- [ ] **Step 6:** Commit any fixes — `git commit -m "fix: e2e calibration fixes"`.

---

## Self-review notes (done at plan time)

- Spec coverage: Overview (T7 + competitors T10), Value+knobs (T8), Metrics (T9), Research (T11), grading (T5), 10 models (T4), auto WACC/growth (T3), SQLite cache TTLs (T2/T6/T10/T11), error handling (not-found T7, n/a notes T4, 429 T10/T11), AI budget (competitors cached 7d T10, reports 24h T11). Deviation from spec: Recharts dropped for CSS bars (noted in header; simpler, zero deps).
- Type consistency: `getStockBundle`/`StockBundle` used in T6–T11; `computeValuation(s, overrides)` signature same server/client; `linearBand(x, x0, x1)` spread from `GRADING_BANDS` tuples requires `as const` — present.
- No placeholders: every code step has full code or an exact bullet contract; UI steps define exact behavior + reference snippets.
