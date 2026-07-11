import { StockBundle } from "@/lib/data/getStockData";
import { ReverseDcf } from "./insights";
import { FinancialSnapshot, YearData } from "./types";
import { autoWacc, pegGrowth } from "./assumptions";
import { roicOfYear } from "./gate";

// ---------------------------------------------------------------------------
// "The Story" tab — a machine-drafted analyst note built ENTIRELY from our own
// model outputs (no AI call in this module; the optional "Draft with AI" pass
// happens client-side against the rendered text). PURE module — no I/O, same
// convention as the rest of lib/finance. See docs/specs/2026-07-11-intrinsic-
// page-v2.md §B for the seven-block structure this feeds.
// ---------------------------------------------------------------------------

export interface StoryData {
  answer: string;
  narrative: string[];
  thesis: { title: string; body: string }[];
  bearBaseBull:
    | { label: "BEAR" | "BASE" | "BULL"; value: number; fromHerePct: number; caption: string }[]
    | null;
  zones: { label: string; range: string; active: boolean }[] | null;
  killCriteria: { title: string; description: string; reading: string; breached: boolean }[];
  risks: { tag: string; severity: "HIGH" | "MED"; title: string; body: string; watch: string }[];
}

// --- small formatting helpers (kept local, matching gate.ts's `pct1` style
// rather than importing the UI-layer lib/format — this module stays a
// self-contained pure leaf of lib/finance). ---------------------------------

function money(x: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(x);
}

function pctWhole(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function operatingMargin(y: YearData): number | null {
  return y.revenue && y.revenue > 0 && y.operatingIncome !== null ? y.operatingIncome / y.revenue : null;
}

// Average operating margin over up to 5 most-recent statement years.
function operatingMargin5yAvg(s: FinancialSnapshot): number | null {
  const margins = s.years.slice(0, 5).map(operatingMargin).filter((v): v is number => v !== null);
  return margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
}

export function buildStory(bundle: StockBundle, reverse: ReverseDcf): StoryData {
  const { snapshot: s, valuation, quality, gate } = bundle;
  const ccy = s.currency;
  const price = s.price;

  const composite = valuation.composite;
  const survivingCount = valuation.models.filter((m) => m.value !== null).length;
  const upside = composite !== null ? composite / price - 1 : null; // >0 = price below fair value

  const implied = reverse.impliedGrowth !== null ? reverse.impliedGrowth * 100 : null;
  const delivered = pegGrowth(s) !== null ? pegGrowth(s)! * 100 : null;

  const y0 = s.years[0];
  const roic = y0 !== undefined ? roicOfYear(y0) : null;
  const wacc = autoWacc(s);
  const marginLatest = y0 !== undefined ? operatingMargin(y0) : null;
  const margin5yAvg = operatingMargin5yAvg(s);

  // Trimmed-mean composite requires >=5 valid models (valuation.ts), so
  // whenever composite is non-null there are at least a bear and a bull to
  // report; this is the single guard for blocks 4 ("What It's Worth") and 5
  // ("The Plan"), matching the spec's "null when composite null" contract.
  const validModels = valuation.models.filter(
    (m): m is typeof m & { value: number } => m.value !== null
  );
  const sortedModels = [...validModels].sort((a, b) => a.value - b.value);
  const bearModel = composite !== null ? sortedModels[0] : null;
  const bullModel = composite !== null ? sortedModels[sortedModels.length - 1] : null;

  // -------------------------------------------------------------------------
  // Block 1 — The Answer
  // -------------------------------------------------------------------------
  let answer = `${s.name} carries a quality gate score of ${gate.score}/100 (${gate.grade})`;
  if (composite !== null) {
    answer += ` with a trimmed-mean fair value of ${money(composite, ccy)} across ${survivingCount} surviving methods`;
  }
  answer += ".";
  if (composite !== null && upside !== null) {
    const dir = upside >= 0 ? "below" : "above";
    answer += ` The market price sits ${Math.round(Math.abs(upside) * 100)}% ${dir} that estimate`;
    if (implied !== null && delivered !== null) {
      answer += `, while today's price implies ~${Math.round(implied)}% annual growth against a delivered five-year record of ~${Math.round(delivered)}%`;
    }
    answer += ".";
  } else if (implied !== null && delivered !== null) {
    answer += ` Today's price implies ~${Math.round(implied)}% annual growth against a delivered five-year record of ~${Math.round(delivered)}%.`;
  }

  // -------------------------------------------------------------------------
  // Block 2 — The Narrative
  // -------------------------------------------------------------------------
  const narrative: string[] = [];
  {
    const clauses: string[] = [];
    if (roic !== null) {
      clauses.push(
        `returns on invested capital of ~${pctWhole(roic)} against a ~${pctWhole(wacc)} cost of capital`
      );
    }
    if (marginLatest !== null && margin5yAvg !== null) {
      clauses.push(
        `operating margins of ${pctWhole(marginLatest)} versus a five-year average of ${pctWhole(margin5yAvg)}`
      );
    }
    if (clauses.length > 0) {
      narrative.push(`The quality picture: ${clauses.join(", ")}.`);
    }
  }
  if (implied !== null && delivered !== null) {
    narrative.push(
      `What the market believes: the current price embeds roughly ${Math.round(implied)}% annual growth for a decade, against a delivered record of ${Math.round(delivered)}%. The gap between those two numbers is where this story will be argued.`
    );
  }

  // -------------------------------------------------------------------------
  // Block 3 — The Thesis, numbered
  // -------------------------------------------------------------------------
  const thesis: { title: string; body: string }[] = [];
  {
    let body: string;
    if (quality.overallScore !== null && roic !== null) {
      body = `Composite quality ${Math.round(quality.overallScore)}/100 across six dimensions; ROIC ~${pctWhole(roic)} vs ~${pctWhole(wacc)} cost of capital.`;
    } else if (quality.overallScore !== null) {
      body = `Composite quality ${Math.round(quality.overallScore)}/100 across six dimensions.`;
    } else if (roic !== null) {
      body = `ROIC ~${pctWhole(roic)} vs ~${pctWhole(wacc)} cost of capital.`;
    } else {
      body = "n/a — insufficient data for a quality reading.";
    }
    thesis.push({ title: "The quality reading", body });
  }
  {
    let body: string;
    if (implied !== null && delivered !== null) {
      const burden = delivered > implied ? "bears" : "bulls";
      body = `Implied growth ${Math.round(implied)}% vs delivered ${Math.round(delivered)}% — the burden of proof currently sits on the ${burden}.`;
    } else {
      body = "n/a — insufficient growth history to size the pricing gap.";
    }
    thesis.push({ title: "The pricing gap", body });
  }
  {
    const body = bearModel
      ? `The lowest surviving valuation method — ${bearModel.name} — lands at ${money(bearModel.value, ccy)}, the model's answer to "what if the optimism is wrong."`
      : "n/a — fewer than five valuation methods survived, so no named floor is defined.";
    thesis.push({ title: "The named floor", body });
  }

  // -------------------------------------------------------------------------
  // Block 4 — What It's Worth (Bear / Base / Bull)
  // -------------------------------------------------------------------------
  let bearBaseBull: StoryData["bearBaseBull"] = null;
  if (composite !== null && bearModel && bullModel) {
    bearBaseBull = [
      {
        label: "BEAR",
        value: bearModel.value,
        fromHerePct: (bearModel.value / price - 1) * 100,
        caption: "The most pessimistic method the trim allowed to vote — the model's named floor.",
      },
      {
        label: "BASE",
        value: composite,
        fromHerePct: (composite / price - 1) * 100,
        caption: "The record, extended and discounted, with the extremes removed.",
      },
      {
        label: "BULL",
        value: bullModel.value,
        fromHerePct: (bullModel.value / price - 1) * 100,
        caption: "The most optimistic surviving method — what being very right is worth.",
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Block 5 — The Plan (price zones)
  // -------------------------------------------------------------------------
  let zones: StoryData["zones"] = null;
  if (composite !== null && bearModel && bullModel) {
    // Monotonic boundaries (each clamped up to the previous) so the five
    // half-open intervals always partition the real line into exactly five
    // non-overlapping pieces, even on unusual data where e.g. the bear floor
    // sits above composite*0.95 — a zone can go zero-width, but there is
    // always exactly one active zone.
    const b0 = bearModel.value;
    const b1 = Math.max(b0, composite * 0.95);
    const b2 = Math.max(b1, composite * 1.05);
    const b3 = Math.max(b2, (composite + bullModel.value) / 2);

    const idx = price < b0 ? 0 : price < b1 ? 1 : price < b2 ? 2 : price < b3 ? 3 : 4;

    zones = [
      {
        label: "Full conviction — margin of safety vs even the bear case",
        range: `< ${money(b0, ccy)}`,
        active: idx === 0,
      },
      {
        label: "Accumulate — base case offers meaningful upside",
        range: `${money(b0, ccy)} – ${money(b1, ccy)}`,
        active: idx === 1,
      },
      {
        label: "Hold, don't add — the record is mostly paid for",
        range: `${money(b1, ccy)} – ${money(b2, ccy)}`,
        active: idx === 2,
      },
      {
        label: "Patience — let the next catalyst speak first",
        range: `${money(b2, ccy)} – ${money(b3, ccy)}`,
        active: idx === 3,
      },
      {
        label: "Trim into strength — price assumes the bull case",
        range: `> ${money(b3, ccy)}`,
        active: idx === 4,
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Block 6 — Kill Criteria
  // -------------------------------------------------------------------------
  const killCriteria: StoryData["killCriteria"] = [];
  {
    const spreadPp = roic !== null ? (roic - wacc) * 100 : null;
    killCriteria.push({
      title: "1 · Returns spread collapses",
      description: `ROIC falls to or below the ~${pctWhole(wacc)} cost-of-capital assumption.`,
      reading:
        spreadPp !== null
          ? `spread ${spreadPp >= 0 ? "+" : ""}${Math.round(spreadPp)} pts vs cost of capital`
          : "n/a — ROIC unavailable",
      breached: roic !== null && roic <= wacc,
    });
  }
  {
    killCriteria.push({
      title: "2 · The gap closes from the wrong side",
      description: "Reverse-DCF implied growth rises to meet the delivered five-year growth record.",
      reading:
        implied !== null && delivered !== null
          ? `implied ${Math.round(implied)}% vs delivered ${Math.round(delivered)}%`
          : "n/a — insufficient growth data",
      breached: implied !== null && delivered !== null && implied >= delivered,
    });
  }
  {
    const ratio =
      marginLatest !== null && margin5yAvg !== null && margin5yAvg > 0 ? marginLatest / margin5yAvg : null;
    killCriteria.push({
      title: "3 · The margin base erodes",
      description: "Operating margin falls below 50% of its own five-year average.",
      reading: ratio !== null ? `margin at ${Math.round(ratio * 100)}% of 5Y average` : "n/a — margin data unavailable",
      breached: ratio !== null && ratio < 0.5,
    });
  }
  {
    killCriteria.push({
      title: "4 · Price exits the valid range",
      description:
        "Price closes below the bear floor or above the bull ceiling — the original question has changed.",
      reading:
        bearModel && bullModel
          ? `price ${money(price, ccy)} in ${money(bearModel.value, ccy)}–${money(bullModel.value, ccy)}`
          : "n/a — no valid range (fewer than five surviving methods)",
      breached: bearModel !== null && bullModel !== null && (price < bearModel.value || price > bullModel.value),
    });
  }

  // -------------------------------------------------------------------------
  // Block 7 — Risks, ranked (fixed set, live watch readings)
  // -------------------------------------------------------------------------
  const fetchedDate = new Date(s.fetchedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const risks: StoryData["risks"] = [
    {
      tag: "MODEL",
      severity: "HIGH",
      title: "Single-source data",
      body: "Every number here derives from one data vendor; a restated filing reprices the whole story.",
      watch: `next 10-Q vs figures loaded ${fetchedDate}`,
    },
    {
      tag: "VALUATION",
      severity: "MED",
      title: "Discount-rate sensitivity",
      body: `The composite leans on a ${pctWhole(wacc)} rate by design; at materially higher rates the fair value compresses toward price.`,
      watch: `10Y yield (${(s.riskFreeRate * 100).toFixed(1)}%)`,
    },
    {
      tag: "CYCLICAL",
      severity: "MED",
      title: "Trend extrapolation",
      body: "Staged DCFs seed growth from the trailing record; a cycle peak in that record inflates every stage.",
      watch: "next two revenue prints",
    },
  ];

  return { answer, narrative, thesis, bearBaseBull, zones, killCriteria, risks };
}
