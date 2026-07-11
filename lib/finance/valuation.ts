import {
  Assumptions,
  FinancialSnapshot,
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
  let cf = base;
  let pv = 0;
  threeStagePath(g, terminalGrowth).forEach((gr, i) => {
    cf *= 1 + gr;
    pv += cf / Math.pow(1 + wacc, i + 1);
  });
  return pv;
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
  let cf = base;
  let pv = 0;
  linearFadePath(g0, gT).forEach((g, i) => {
    cf *= 1 + g;
    pv += cf / Math.pow(1 + wacc, i + 1);
  });
  const tv = (cf * (1 + gT)) / (wacc - gT);
  pv += tv / Math.pow(1 + wacc, HORIZON);
  return pv;
}

function discountedSeries(base: number, a: Assumptions, variant: ValuationVariant): number | null {
  return variant === "textbook"
    ? textbookPv(base, a.normalGrowth, a.wacc, a.terminalGrowth)
    : threeStagePv(base, a.normalGrowth, a.wacc, a.terminalGrowth);
}

type Ctx = { s: FinancialSnapshot; a: Assumptions; variant: ValuationVariant };

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
  const pv = discountedSeries(base, ctx.a, ctx.variant);
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
  // sector-median multiple takes priority when provided; own history is the fallback
  sectorMult?: number
): { value: number | null; note?: string; variant?: string } {
  const m0 = metric(latest(s));
  if (m0 === null || m0 <= 0)
    return { value: null, note: `n/a — missing/negative ${label}` };
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

export function computeValuation(
  s: FinancialSnapshot,
  overrides: Partial<Assumptions> = {},
  variant: ValuationVariant = "calibrated"
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

  const ctx: Ctx = { s, a, variant };

  // TTM bases preferred (reference architecture) for calibrated; textbook
  // uses audited latest-fiscal-year statements only — "textbook analysts use
  // audited annuals," per the brief.
  const ocfBase = variant === "textbook" ? y.operatingCashFlow : s.ttm?.operatingCashFlow ?? y.operatingCashFlow;
  const fcfBase = variant === "textbook" ? y.freeCashFlow : s.ttm?.freeCashFlow ?? y.freeCashFlow;
  const niBase = variant === "textbook" ? y.netIncome : s.ttm?.netIncome ?? y.netIncome;

  add("dcf20", "DCF-20", "20Y · Operating CF", dcfModel(ocfBase, "operating cash flow", ctx, true));
  add("dfcf20", "DFCF-20", "20Y · Free CF", dcfModel(fcfBase, "free cash flow", ctx, true));
  add("dni20", "DNI-20", "20Y · Net Income", dcfModel(niBase, "net income", ctx, false));

  // H-model: V = FCF0 * [(1+gT) + H*(g0-gT)] / (wacc - gT), on TTM FCF
  {
    const fcf = fcfBase;
    if (fcf === null || fcf <= 0)
      add("hmodel", "H-Model DCF", "Intrinsic", { value: null, note: "n/a — negative/missing FCF" });
    else if (a.wacc <= a.terminalGrowth)
      add("hmodel", "H-Model DCF", "Intrinsic", { value: null, note: TERM_NOTE });
    else {
      const v =
        (fcf * (1 + a.terminalGrowth + a.hHalfLife * (a.normalGrowth - a.terminalGrowth))) /
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
    const r = multipleModel(s, (yy) => yy.ebitda, "EBITDA", true);
    add("evEbitda", "EV / EBITDA", r.variant ?? "Multiples", r);
  }
  {
    const r = multipleModel(s, (yy) => yy.revenue, "revenue", true, multiples.evRev);
    add("evRevenue", "EV / Revenue", r.variant ?? "Multiples", r);
  }
  {
    const r = multipleModel(s, (yy) => yy.freeCashFlow, "free cash flow", false, multiples.pFcf);
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
      const path =
        variant === "textbook"
          ? linearFadePath(a.normalGrowth, a.terminalGrowth)
          : threeStagePath(a.normalGrowth, a.terminalGrowth);
      let r = rev;
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
      add("peg", "PEG-implied", "Growth", { value: eps * g100 });
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
    autoNormalGrowth: autoNormalGrowth(s, variant),
    autoWacc: autoWacc(s, variant),
  };
}
