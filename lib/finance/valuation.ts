import {
  Assumptions,
  FinancialSnapshot,
  Horizon,
  ModelResult,
  ValuationOutput,
  ValuationVariant,
} from "./types";
import { autoNormalGrowth, autoWacc, pegGrowth, resolveAssumptions } from "./assumptions";
import { clamp, median } from "./helpers";

// Sector-median multiples — extracted VERBATIM from the reference site's
// "Multiples vs Peers & History" sections across 11 sector-representative
// tickers (Jul 2026): WDAY/NVDA GOOGL XOM JPM JNJ KO HD CAT NEE LIN PLD.
// P/FCF via sector median reproduced its method value exactly on 12/12.
// EV/EBITDA intentionally stays own-history (matched ≈9/12 within 5%).
export const SECTOR_MULTIPLES: Record<
  string,
  { evRev: number; pFcf: number; pe: number; evEbitda: number }
> = {
  Technology: { evRev: 5.5, pFcf: 30, pe: 28, evEbitda: 18 },
  "Communication Services": { evRev: 3.0, pFcf: 22, pe: 22, evEbitda: 13 },
  "Consumer Cyclical": { evRev: 1.8, pFcf: 22, pe: 22, evEbitda: 14 },
  "Consumer Defensive": { evRev: 2.0, pFcf: 22, pe: 22, evEbitda: 14 },
  Healthcare: { evRev: 4.5, pFcf: 25, pe: 22, evEbitda: 15 },
  "Financial Services": { evRev: 3.0, pFcf: 13, pe: 13, evEbitda: 10 },
  Industrials: { evRev: 2.0, pFcf: 22, pe: 20, evEbitda: 12 },
  Energy: { evRev: 1.2, pFcf: 12, pe: 14, evEbitda: 7 },
  Utilities: { evRev: 2.5, pFcf: 22, pe: 18, evEbitda: 11 },
  "Basic Materials": { evRev: 1.5, pFcf: 18, pe: 16, evEbitda: 10 },
  "Real Estate": { evRev: 6.0, pFcf: 25, pe: 25, evEbitda: 18 },
};

// Industry-level overrides — the reference site's multiple lookup is actually
// INDUSTRY-level (Yahoo assetProfile.industry), not sector-level: its META page
// implies EV/Rev 5.3x for "Internet Content & Information" while VZ shows 3.0x
// for "Telecom Services" — both roll up to the same "Communication Services"
// sector, so a single sector figure can't reproduce both. Any field an industry
// entry omits falls through to that ticker's sector value (see resolveMultiples),
// then to the own-history median if the sector is also unknown/missing the field.
export const INDUSTRY_MULTIPLES: Record<
  string,
  Partial<{ evRev: number; pFcf: number; pe: number; evEbitda: number }>
> = {
  "Internet Content & Information": { evRev: 5.3, pFcf: 20 },
  "Telecom Services": { evRev: 3.0 },
  Semiconductors: { evRev: 6.6 },
  "Software - Application": { evRev: 6.6, pFcf: 31 },
  "Software - Infrastructure": { evRev: 6.6, pFcf: 31 },
};

// Resolution order per field: industry override → sector value → undefined
// (caller falls back to the own-history median). EXPORTED so both
// computeValuation (evRev/pFcf model overrides) and insights.ts's
// multiplesComparison (sectorMedian column, despite the name — it now reflects
// the industry-first lookup) share one merge instead of duplicating it.
export function resolveMultiples(
  s: FinancialSnapshot
): Partial<{ evRev: number; pFcf: number; pe: number; evEbitda: number }> {
  const industryMult = s.industry != null ? INDUSTRY_MULTIPLES[s.industry] : undefined;
  const sectorMult = s.sector != null ? SECTOR_MULTIPLES[s.sector] : undefined;
  const pick = (k: "evRev" | "pFcf" | "pe" | "evEbitda") => industryMult?.[k] ?? sectorMult?.[k];
  return { evRev: pick("evRev"), pFcf: pick("pFcf"), pe: pick("pe"), evEbitda: pick("evEbitda") };
}

// Trailing P/E = price / TTM EPS. Null when EPS isn't positive (a loss-making
// or break-even trailing year has no meaningful P/E) or EPS is unknown.
export function trailingPE(s: FinancialSnapshot): number | null {
  if (s.trailingEPS === null || !(s.trailingEPS > 0)) return null;
  return s.price / s.trailingEPS;
}

// PEG = trailing P/E ÷ (growth rate as a whole number, e.g. 20 for 20%), using
// the same 5Y net-income CAGR (pegGrowth) the PEG-implied valuation model
// uses. Null when growth is non-positive (PEG is meaningless for a shrinking
// or loss-making growth base) or P/E itself is null.
export function pegRatio(s: FinancialSnapshot): number | null {
  const pe = trailingPE(s);
  if (pe === null) return null;
  const g = pegGrowth(s);
  if (g === null || g <= 0) return null;
  return pe / (100 * g);
}

const HORIZON = 20;

// Three-stage growth path (the reference site's verified live architecture):
// years 1–5 at the seed g, years 6–10 at 0.70·g, years 11–20 at the terminal
// knob. NO Gordon terminal value beyond year 20 — the 20-year window is the
// whole valuation (replicated ratio-1.000 on 12/12 reference tickers).
function threeStagePath(g: number, gT: number): number[] {
  return Array.from({ length: HORIZON }, (_, i) =>
    i < 5 ? g : i < 10 ? 0.7 * g : gT
  );
}

// Core loop shared by every path-driven model: grows `base` along an
// explicit per-year growth-rate array and discounts each year's cash flow at
// `wacc`. No terminal value — that's layered on top by callers that need one
// (textbookPv's Gordon TV). Returns the final year's cash flow too, since the
// Gordon TV is computed off of it and re-deriving it would re-walk the path.
function pathPv(base: number, path: number[], wacc: number): { pv: number; finalCf: number } {
  let cf = base;
  let pv = 0;
  path.forEach((g, i) => {
    cf *= 1 + g;
    pv += cf / Math.pow(1 + wacc, i + 1);
  });
  return { pv, finalCf: cf };
}

// PV of the 20-year three-stage flow series. Pure sum — no terminal value.
// EXPORTED so insights.ts (reverse-DCF) inverts exactly what dcf20 computes,
// instead of duplicating the projection math.
export function threeStagePv(
  base: number,
  g: number,
  wacc: number,
  terminalGrowth = 0.04
): number | null {
  if (wacc <= 0) return null;
  return pathPv(base, threeStagePath(g, terminalGrowth), wacc).pv;
}

// Linear interpolation of the growth rate from g0 (year 1) to gT (year 20)
// across the 20-year window — the textbook variant's fade shape. (Calibrated
// instead steps through three discrete stages with no terminal value; see
// threeStagePath above.)
function linearFadePath(g0: number, gT: number): number[] {
  return Array.from({ length: HORIZON }, (_, i) => g0 + (gT - g0) * (i / (HORIZON - 1)));
}

// Classic finance-textbook DCF: cash flow fades LINEARLY from g0 to gT across
// 20 years, each year discounted, PLUS a Gordon terminal value on year 20's
// cash flow (TV = CF20*(1+gT)/(wacc-gT), discounted 20 years) — the perpetuity
// piece the calibrated three-stage engine deliberately omits. Exported so the
// flat-perpetuity identity (g0=gT=0 → base/wacc exactly) can be unit-tested
// directly, and so Revenue DCF's textbook branch can share the same fade
// shape via linearFadePath.
export function textbookPv(
  base: number,
  g0: number,
  wacc: number,
  gT: number
): number | null {
  if (wacc <= gT) return null;
  const { pv, finalCf } = pathPv(base, linearFadePath(g0, gT), wacc);
  const tv = (finalCf * (1 + gT)) / (wacc - gT);
  return pv + tv / Math.pow(1 + wacc, HORIZON);
}

// The variant's own 20-year growth-rate path built from the resolved
// assumptions — calibrated's three discrete stages, or textbook's linear
// fade. Shared by every path-driven model (DCF family + Revenue DCF) so the
// nextYear-horizon shift (`advance`, below) is written and tested once
// instead of re-derived per model.
function growthPath(a: Assumptions, variant: ValuationVariant): number[] {
  return variant === "textbook"
    ? linearFadePath(a.normalGrowth, a.terminalGrowth)
    : threeStagePath(a.normalGrowth, a.terminalGrowth);
}

// nextYear horizon, generic path transform: the first year of the path has
// already elapsed, so drop it and append one more year at the terminal rate
// — the projection window stays 20 years long, just one year further out.
// (Calibrated: years 1-5/6-10/11-20 → 1-4/5-9/10-20, i.e. one seed year
// consumed. Textbook: the fade restarts from its old year-2 point, with one
// extra terminal-rate year tacked on the end.) Callers pair this with
// rebasing the cash flow itself by the path's OLD first-year rate (see
// discountedSeries) — that rate is "the year that just elapsed."
function advance(path: number[], terminalGrowth: number): number[] {
  return [...path.slice(1), terminalGrowth];
}

// Discounts `base` along the variant's own growth path over a fixed 20-year
// window; textbook layers a Gordon terminal value on the path's final cash
// flow (same shape as textbookPv). Used by the DCF family for BOTH horizons:
// "current" discounts the path as built; "nextYear" first rebases `base` one
// year along the path's own first-year growth rate, then discounts the
// shifted path (`advance`) — a generic transform, not per-model duplication.
function discountedSeries(
  base: number,
  a: Assumptions,
  variant: ValuationVariant,
  horizon: Horizon
): number | null {
  const path0 = growthPath(a, variant);
  const guardFails = variant === "textbook" ? a.wacc <= a.terminalGrowth : a.wacc <= 0;
  if (guardFails) return null;

  const base1 = horizon === "nextYear" ? base * (1 + path0[0]) : base;
  const path = horizon === "nextYear" ? advance(path0, a.terminalGrowth) : path0;

  const { pv, finalCf } = pathPv(base1, path, a.wacc);
  if (variant === "textbook") {
    const tv = (finalCf * (1 + a.terminalGrowth)) / (a.wacc - a.terminalGrowth);
    return pv + tv / Math.pow(1 + a.wacc, HORIZON);
  }
  return pv;
}

type Ctx = { s: FinancialSnapshot; a: Assumptions; variant: ValuationVariant; horizon: Horizon };

function latest(s: FinancialSnapshot) {
  return s.years[0];
}

function perShare(equity: number, s: FinancialSnapshot): number {
  return equity / s.sharesOutstanding;
}

const TERM_NOTE = "n/a — terminal growth must be below WACC";
// textbook variant's Gordon TV requires wacc strictly above the terminal
// growth rate, same mathematical constraint as calibrated's H-model guard,
// worded per the task brief since textbook always carries a terminal value.
const TEXTBOOK_TERM_NOTE = "n/a — discount rate must exceed terminal growth";

// ---- DCF family -----------------------------------------------------------

function dcfModel(
  base: number | null,
  label: string,
  ctx: Ctx,
  adjustNetDebt: boolean
): { value: number | null; note?: string } {
  if (base === null) return { value: null, note: `n/a — missing ${label}` };
  if (base <= 0) return { value: null, note: `n/a — negative ${label}` };
  const pv = discountedSeries(base, ctx.a, ctx.variant, ctx.horizon);
  if (pv === null) return { value: null, note: ctx.variant === "textbook" ? TEXTBOOK_TERM_NOTE : TERM_NOTE };
  const y = latest(ctx.s);
  const adj = adjustNetDebt ? (y.cash ?? 0) - (y.totalDebt ?? 0) : 0;
  const equity = pv + adj;
  // Reason: a negative implied share price is meaningless — null it out so it
  // cannot drag the trimmed-mean composite negative.
  if (equity <= 0)
    return { value: null, note: "n/a — net debt exceeds intrinsic value" };
  return { value: perShare(equity, ctx.s) };
}

// ---- historical multiples -------------------------------------------------

// per-year: EV_t = yearEndPrice*shares + debt - cash; returns median of metric ratios
// EXPORTED for insights.ts's multiplesComparison (own-history median column).
export function medianMultiple(
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
  useEV: boolean,
  ctx: Ctx,
  // sector-median multiple takes priority when provided; own history is the fallback
  sectorMult?: number
): { value: number | null; note?: string; variant?: string } {
  const m0raw = metric(latest(s));
  if (m0raw === null || m0raw <= 0)
    return { value: null, note: `n/a — missing/negative ${label}` };
  // nextYear horizon: next year's metric = current metric x (1 + seed
  // growth), same multiple, same equity math. Revenue has its own growth
  // rate concept; EBITDA/FCF don't project a separate growth path in this
  // model family, so the seed (normalGrowth) is used as a proxy for all three.
  const m0 = ctx.horizon === "nextYear" ? m0raw * (1 + ctx.a.normalGrowth) : m0raw;
  const ownMult = sectorMult === undefined ? medianMultiple(s, metric, useEV) : null;
  const mult = sectorMult ?? ownMult;
  if (mult === null)
    return { value: null, note: "n/a — no price history for own multiple" };
  const y = latest(s);
  const fair = useEV ? mult * m0 - (y.totalDebt ?? 0) + (y.cash ?? 0) : mult * m0;
  // Reason: same invariant as dcfModel — never emit a negative implied price.
  if (fair <= 0)
    return { value: null, note: "n/a — net debt exceeds multiple-implied value" };
  return {
    value: perShare(fair, s),
    variant: sectorMult !== undefined ? "Sector multiple" : "Own-history multiple",
  };
}

// ---- main -----------------------------------------------------------------

// The two horizons buildModels actually walks the engine for — "current" and
// the one-fiscal-year-forward point. q1/q2/q3 (below) are never passed in here;
// they're derived by interpolating between these two endpoint runs instead.
type EndpointHorizon = "current" | "nextYear";

// Builds all 10 models for one endpoint horizon. Split out of
// computeValuation so the q1/q2/q3 quarterly horizons (see interpolateModel) can
// run this exactly twice per render — once per endpoint — and derive the
// quarter points by interpolation, instead of re-walking the engine 4 times.
function buildModels(
  s: FinancialSnapshot,
  overrides: Partial<Assumptions>,
  a: Assumptions,
  variant: ValuationVariant,
  horizon: EndpointHorizon
): ModelResult[] {
  const y = latest(s);
  const models: ModelResult[] = [];
  // Reason: the "variant" param name would shadow the outer computeValuation
  // variant (calibrated/textbook) — this callback's third arg is instead the
  // per-model variant LABEL (e.g. "20Y · Operating CF"), an unrelated,
  // pre-existing concept on ModelResult. Named modelVariant here to keep the
  // two apart.
  const add = (
    key: string,
    name: string,
    modelVariant: string,
    r: { value: number | null; note?: string }
  ) => models.push({ key, name, variant: modelVariant, ...r });

  const ctx: Ctx = { s, a, variant, horizon };

  // TTM bases preferred (reference architecture) for calibrated; textbook
  // uses audited latest-fiscal-year statements only — "textbook analysts use
  // audited annuals," per the brief.
  const ocfBase = variant === "textbook" ? y.operatingCashFlow : s.ttm?.operatingCashFlow ?? y.operatingCashFlow;
  const fcfBase = variant === "textbook" ? y.freeCashFlow : s.ttm?.freeCashFlow ?? y.freeCashFlow;
  const niBase = variant === "textbook" ? y.netIncome : s.ttm?.netIncome ?? y.netIncome;

  add("dcf20", "DCF-20", "20Y · Operating CF", dcfModel(ocfBase, "operating cash flow", ctx, true));
  add("dfcf20", "DFCF-20", "20Y · Free CF", dcfModel(fcfBase, "free cash flow", ctx, true));
  add("dni20", "DNI-20", "20Y · Net Income", dcfModel(niBase, "net income", ctx, false));

  // H-model: V = FCF0 * [(1+gT) + H*(g0-gT)] / (wacc - gT), on TTM FCF.
  // nextYear horizon: FCF0 becomes one year older (FCF0 * (1 + seed growth))
  // — the starting point of the same fade formula, unchanged otherwise.
  {
    const fcf = fcfBase;
    if (fcf === null || fcf <= 0)
      add("hmodel", "H-Model DCF", "Intrinsic", { value: null, note: "n/a — negative/missing FCF" });
    else if (a.wacc <= a.terminalGrowth)
      add("hmodel", "H-Model DCF", "Intrinsic", { value: null, note: TERM_NOTE });
    else {
      const fcf1 = horizon === "nextYear" ? fcf * (1 + a.normalGrowth) : fcf;
      const v =
        (fcf1 * (1 + a.terminalGrowth + a.hHalfLife * (a.normalGrowth - a.terminalGrowth))) /
        (a.wacc - a.terminalGrowth);
      // Reason: a steep assumed decline (large negative normalGrowth) can drive
      // the H-model numerator negative — mirror dcfModel's guard so we never emit
      // a negative implied price that would drag the composite down.
      if (v <= 0)
        add("hmodel", "H-Model DCF", "Intrinsic", {
          value: null,
          note: "n/a — assumed decline implies no positive value",
        });
      else add("hmodel", "H-Model DCF", "Intrinsic", { value: perShare(v, s) });
    }
  }

  // EV/EBITDA: own-history median (matches reference site). EV/Revenue and
  // P/FCF: industry-level multiples when known (falling back to sector-level),
  // else fall back to own history. See resolveMultiples for the merge order.
  // textbook variant: no sector/industry tables at all — own-history medians
  // only, so leave `multiples` empty and let multipleModel fall through.
  const multiples = variant === "textbook" ? {} : resolveMultiples(s);
  {
    const r = multipleModel(s, (yy) => yy.ebitda, "EBITDA", true, ctx);
    add("evEbitda", "EV / EBITDA", r.variant ?? "Multiples", r);
  }
  {
    const r = multipleModel(s, (yy) => yy.revenue, "revenue", true, ctx, multiples.evRev);
    add("evRevenue", "EV / Revenue", r.variant ?? "Multiples", r);
  }
  {
    const r = multipleModel(s, (yy) => yy.freeCashFlow, "free cash flow", false, ctx, multiples.pFcf);
    add("pFcf", "P / FCF", r.variant ?? "Multiples", r);
  }

  // Revenue DCF: project revenue on a growth path (calibrated: three-stage,
  // no terminal value; textbook: linear fade g0->gT PLUS a Gordon terminal
  // value on year 20's implied net income — same shape as textbookPv, layered
  // under the margin-expansion multiplier since this model's cash flow isn't
  // a flat base but base*margin_t). margin_t = min(m0 + mExp*t, m0+0.10) in
  // both variants; PV of implied net income.
  {
    const rev = y.revenue;
    const ni = niBase;
    if (rev === null || rev <= 0 || ni === null)
      add("revDcf", "Revenue DCF", "Growth", { value: null, note: "n/a — missing revenue/net income" });
    else if (variant === "textbook" && a.wacc <= a.terminalGrowth)
      add("revDcf", "Revenue DCF", "Growth", { value: null, note: TEXTBOOK_TERM_NOTE });
    else if (a.wacc <= 0)
      add("revDcf", "Revenue DCF", "Growth", { value: null, note: "n/a — WACC must be positive" });
    else {
      const m0 = ni / rev;
      const path0 = growthPath(a, variant);
      // nextYear horizon: revenue advances one year along the path's own
      // first-year growth rate, and the path itself shifts left one year
      // (same generic `advance` transform the DCF family uses) — see
      // discountedSeries above for the shared mechanics.
      const rev1 = horizon === "nextYear" ? rev * (1 + path0[0]) : rev;
      const path = horizon === "nextYear" ? advance(path0, a.terminalGrowth) : path0;
      let r = rev1;
      let pv = 0;
      let niT = 0;
      path.forEach((g, i) => {
        r *= 1 + g;
        const m = Math.min(m0 + a.marginExpansion * (i + 1), m0 + 0.1);
        niT = r * m;
        pv += niT / Math.pow(1 + a.wacc, i + 1);
      });
      if (variant === "textbook") {
        const tv = (niT * (1 + a.terminalGrowth)) / (a.wacc - a.terminalGrowth);
        pv += tv / Math.pow(1 + a.wacc, HORIZON);
      }
      if (pv <= 0)
        add("revDcf", "Revenue DCF", "Growth", { value: null, note: "n/a — negative projected earnings" });
      else add("revDcf", "Revenue DCF", "Growth", { value: perShare(pv, s) });
    }
  }

  // PEG-implied: fair P/E = growth% (PEG = 1). Reference site's growth input
  // back-solves to the 5Y NET-INCOME CAGR, uncapped (GOOGL 24.8 vs actual
  // 25.2, NVDA ≈99, KO 9.7 vs 10.0). Sanity cap 100 (calibrated only). A
  // manual growth override still wins, since the user explicitly chose it.
  // textbook: pure formula, no sanity cap at all.
  {
    const eps = s.trailingEPS;
    const gRaw = overrides.normalGrowth !== undefined ? a.normalGrowth : pegGrowth(s) ?? a.normalGrowth;
    if (eps === null || eps <= 0)
      add("peg", "PEG-implied", "Growth", { value: null, note: "n/a — negative/missing EPS" });
    else if (gRaw <= 0)
      add("peg", "PEG-implied", "Growth", { value: null, note: "n/a — no growth" });
    else {
      const g100 = variant === "textbook" ? gRaw * 100 : clamp(gRaw * 100, 0, 100);
      // nextYear horizon: EPS advances one year along the PEG growth rate;
      // the fair P/E (= g100, PEG of 1) is unchanged.
      const eps1 = horizon === "nextYear" ? eps * (1 + gRaw) : eps;
      add("peg", "PEG-implied", "Growth", { value: eps1 * g100 });
    }
  }

  // Graham revised: V = EPS · (8.5 + 2g) · 4.4 / Y. Reference-verified on all
  // 12 calibration tickers: g = growth seed capped at 30, Y = 5.0 (fixed AAA
  // proxy — back-solves exactly with Y=5.0 on every ticker). textbook: pure
  // formula, no growth cap at all.
  {
    const eps = s.trailingEPS;
    if (eps === null || eps <= 0)
      add("graham", "Graham Revised", "EPS × growth", { value: null, note: "n/a — negative/missing EPS" });
    else {
      const g100 = variant === "textbook" ? a.normalGrowth * 100 : clamp(a.normalGrowth * 100, 0, 30);
      const Y = 5.0;
      // nextYear horizon: EPS advances one year along the growth seed; same
      // Graham formula otherwise.
      const eps1 = horizon === "nextYear" ? eps * (1 + a.normalGrowth) : eps;
      add("graham", "Graham Revised", "EPS × growth", {
        value: (eps1 * (8.5 + 2 * g100) * 4.4) / Y,
      });
    }
  }

  return models;
}

// Geometric interpolation between the two exact endpoints (today's value and
// the 1-year-forward value) at fraction f (0.25 for q1/3-mo, 0.5 for
// q2/6-mo, 0.75 for q3/9-mo): V(q) = Vcur * (Vnext/Vcur)^f — the constant-rate-accretion path
// between the two points. Exact for the multiples/PEG/Graham family (equals
// metric*(1+g)^f) and a correct first-order roll for the DCF/H-model family.
// ponytail: this is geometric interpolation between two pre-computed
// endpoints, not a true fractional-year path shift through the engine —
// upgrade to a real fractional path shift (re-deriving growthPath/advance for
// a partial year) if anyone cares enough to justify the added complexity.
function interpolateModel(cur: ModelResult, next: ModelResult, f: number): ModelResult {
  const v = cur.value;
  const n = next.value;
  // Only interpolate when both endpoints are valid AND strictly positive —
  // a non-positive endpoint makes the ratio undefined/meaningless, so the
  // quarterly value is null rather than guessing.
  const value = v !== null && n !== null && v > 0 && n > 0 ? v * Math.pow(n / v, f) : null;
  const note = value !== null ? undefined : cur.note ?? next.note ?? "n/a — endpoint unavailable";
  return { ...cur, value, note };
}

export function computeValuation(
  s: FinancialSnapshot,
  overrides: Partial<Assumptions> = {},
  variant: ValuationVariant = "calibrated",
  horizon: Horizon = "current"
): ValuationOutput {
  const a = resolveAssumptions(s, overrides, variant);

  // Guard: a valid ticker whose financial statements were unavailable yields an
  // empty `years` array. Every model below dereferences latest(s) === years[0],
  // so short-circuit here and report all 10 models as uniformly n/a. Assumptions
  // still resolve (autoNormalGrowth/autoWacc read no year data), the composite is
  // null, and — critically — PEG is null too: with no history there is nothing to
  // justify a growth figure, so it must not fall back to the auto default.
  if (s.years.length === 0) {
    const NA = "n/a — no financial statements available";
    const models: ModelResult[] = [
      { key: "dcf20", name: "DCF-20", variant: "20Y · Operating CF", value: null, note: NA },
      { key: "dfcf20", name: "DFCF-20", variant: "20Y · Free CF", value: null, note: NA },
      { key: "dni20", name: "DNI-20", variant: "20Y · Net Income", value: null, note: NA },
      { key: "hmodel", name: "H-Model DCF", variant: "Intrinsic", value: null, note: NA },
      { key: "evEbitda", name: "EV / EBITDA", variant: "Multiples", value: null, note: NA },
      { key: "evRevenue", name: "EV / Revenue", variant: "Multiples", value: null, note: NA },
      { key: "pFcf", name: "P / FCF", variant: "Multiples", value: null, note: NA },
      { key: "revDcf", name: "Revenue DCF", variant: "Growth", value: null, note: NA },
      { key: "peg", name: "PEG-implied", variant: "Growth", value: null, note: NA },
      { key: "graham", name: "Graham Revised", variant: "EPS × growth", value: null, note: NA },
    ];
    return {
      models,
      composite: null,
      range: null,
      assumptions: a,
      autoNormalGrowth: autoNormalGrowth(s, variant),
      autoWacc: autoWacc(s, variant),
    };
  }

  // "current"/"nextYear" walk the engine directly, once; "q1"/"q2"/"q3" build
  // both endpoints once each (never 4 engine runs per render) and interpolate.
  let models: ModelResult[];
  if (horizon === "q1" || horizon === "q2" || horizon === "q3") {
    const f = horizon === "q1" ? 0.25 : horizon === "q2" ? 0.5 : 0.75;
    const cur = buildModels(s, overrides, a, variant, "current");
    const next = buildModels(s, overrides, a, variant, "nextYear");
    models = cur.map((m, i) => interpolateModel(m, next[i], f));
  } else {
    models = buildModels(s, overrides, a, variant, horizon);
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
    autoNormalGrowth: autoNormalGrowth(s, variant),
    autoWacc: autoWacc(s, variant),
  };
}
