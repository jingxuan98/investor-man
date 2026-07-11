import { StockBundle } from "@/lib/data/getStockData";
import { DimensionScore } from "./types";

// ---------------------------------------------------------------------------
// SuperInvestor tab — "ANALYST NOTE" prose + dimension chip mapping. PURE
// module (no I/O), same convention as gate.ts / story.ts. Built entirely from
// bundle.quality (our existing 6-dimension engine) and bundle.valuation —
// no new scoring logic here, just templated sentences plugging real numbers.
// Style-matches the reference extractions (plain declarative sentences).
// ---------------------------------------------------------------------------

function money(x: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(x);
}

// Categorical chip for a dimension card. General dims: HIGH/FAIR/WEAK.
// Economic moat: WIDE/NARROW/NONE. Valuation: CHEAP/FAIR/OVERVALUED (a high
// valuation *score* means the stock is cheap vs fair value, hence the
// relabeling — same 70/45 cutoffs as every other dimension).
export function dimensionChip(d: DimensionScore): string {
  if (d.score === null) return "N/A";
  if (d.key === "moat") {
    if (d.score >= 70) return "WIDE";
    if (d.score >= 45) return "NARROW";
    return "NONE";
  }
  if (d.key === "valuation") {
    if (d.score >= 70) return "CHEAP";
    if (d.score >= 45) return "FAIR";
    return "OVERVALUED";
  }
  if (d.score >= 70) return "HIGH";
  if (d.score >= 45) return "FAIR";
  return "WEAK";
}

type ScoredDim = DimensionScore & { score: number };

export function buildAnalystNote(bundle: StockBundle): string[] {
  const { snapshot: s, quality, valuation } = bundle;
  const ccy = s.currency;
  const price = s.price;
  const composite = valuation.composite;
  const paragraphs: string[] = [];

  const scored = quality.dimensions.filter((d): d is ScoredDim => d.score !== null);
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const top2 = sorted.slice(0, 2);
  const weakest = sorted.length ? sorted[sorted.length - 1] : null;

  // --- Paragraph 1 — the case FOR (top-2 scoring dimensions) ---------------
  if (top2.length > 0) {
    const names = top2.map((d) => d.name.toLowerCase()).join(" and ");
    let p1 = `The case for owning ${s.ticker} is durable ${names}`;
    if (quality.overallScore !== null) {
      p1 += `, backing a quality composite of ${quality.overallScore.toFixed(1)}/100`;
    }
    p1 += ".";
    const readings = top2
      .map((d) => d.detail)
      .filter((detail) => detail && !detail.startsWith("n/a"));
    if (readings.length > 0) {
      p1 += ` Supporting reads: ${readings.join("; ")}.`;
    }
    paragraphs.push(p1);
  }

  // --- Paragraph 2 — the case AGAINST (weakest dimension) -------------------
  if (weakest !== null) {
    let p2 = `The case against adding today is ${weakest.name.toLowerCase()} (${weakest.score.toFixed(0)}/100)`;
    if (weakest.detail && !weakest.detail.startsWith("n/a")) {
      p2 += ` — ${weakest.detail}`;
    }
    p2 += ".";
    paragraphs.push(p2);
  }

  // --- Paragraph 3 — the valuation line --------------------------------------
  if (composite !== null && price > 0 && Number.isFinite(composite)) {
    const diffPct = Math.abs(composite / price - 1) * 100;
    const isPremium = composite < price; // spot above fair value = paying a premium
    let p3 = `Our composite fair-value estimate prints ${money(composite, ccy)} versus a ${money(
      price,
      ccy
    )} spot — a ${diffPct.toFixed(1)}% ${isPremium ? "premium" : "discount"}.`;
    p3 += isPremium ? " Wait for a better entry." : " Reasonable margin of safety at current levels.";
    paragraphs.push(p3);
  }

  return paragraphs;
}
