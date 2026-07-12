import { cacheGet, cacheSet } from "@/lib/db";
import { fetchSnapshot } from "./yahoo";
import { computeValuation } from "@/lib/finance/valuation";
import { computeQuality } from "@/lib/finance/grading";
import { computeGate } from "@/lib/finance/gate";
import { FinancialSnapshot, ValuationOutput, QualityOutput, ValuationVariant } from "@/lib/finance/types";
import { GateOutput } from "@/lib/finance/gate";

// One variant's worth of composite-dependent output — valuation (the 10
// methods + trimmed-mean composite) and quality (the 6-dimension grading,
// whose "Valuation" dimension consumes the composite). The Quality GATE
// (computeGate, 4 pass/fail factors) is deliberately NOT here: it never reads
// the composite, so it's identical across variants and lives once on the
// bundle, not per-variant.
export interface VariantBundle {
  valuation: ValuationOutput;
  quality: QualityOutput;
}

export interface StockBundle {
  snapshot: FinancialSnapshot;
  valuation: ValuationOutput; // calibrated — kept as the default/back-compat shape
  quality: QualityOutput; // calibrated — kept as the default/back-compat shape
  gate: GateOutput;
  // Optional (not required) so hand-built StockBundle literals in tests keep
  // compiling unchanged; getStockBundle itself always populates it. Use
  // variantPair()/bundleForVariant() below instead of reading this directly.
  variants?: { calibrated: VariantBundle; textbook: VariantBundle };
}

// Every valuation/quality pair, keyed by variant — the "pair pattern" the
// global variant toggle (VariantProvider/useVariant) relies on: server pages
// compute both once, client leaves pick per useVariant() with no refetch.
// Falls back to the bundle's own (calibrated) valuation/quality for any
// hand-built StockBundle that predates the `variants` field.
export function variantPair(bundle: StockBundle): { calibrated: VariantBundle; textbook: VariantBundle } {
  return (
    bundle.variants ?? {
      calibrated: { valuation: bundle.valuation, quality: bundle.quality },
      textbook: { valuation: bundle.valuation, quality: bundle.quality },
    }
  );
}

// Re-shapes a StockBundle so its top-level valuation/quality are the given
// variant's — snapshot and gate (both variant-independent) pass through
// unchanged. Lets story.ts's buildStory / insightNote.ts's buildAnalystNote /
// ai/prompts.ts's buildPrompt (all typed to take a StockBundle) run once per
// variant with zero changes to their own signatures or logic.
export function bundleForVariant(bundle: StockBundle, variant: ValuationVariant): StockBundle {
  const vb = variantPair(bundle)[variant];
  return { ...bundle, valuation: vb.valuation, quality: vb.quality };
}

const TTL_24H = 24 * 3600;

export async function getStockBundle(ticker: string, force = false): Promise<StockBundle> {
  const key = `stock:${ticker.toUpperCase()}`;
  if (!force) {
    const hit = cacheGet<StockBundle>(key);
    // Treat a pre-`gate` cached bundle (from before this field existed) as a
    // miss so it is recomputed rather than crashing consumers that read gate.
    // Likewise recompute when `currencyMismatch` is absent — those bundles
    // predate ADR currency conversion and may hold home-currency valuations.
    // Likewise recompute when `nextEarningsDate` is absent — those bundles
    // predate The Story tab's "NEXT CATALYST" field.
    // Likewise recompute when `industry` is absent — those bundles predate
    // industry-level multiple overrides and may hold stale evRev/pFcf values.
    // Likewise recompute when `variants` is absent — those bundles predate
    // the global calibrated/textbook variant toggle and only ever priced
    // calibrated.
    if (
      hit &&
      hit.gate &&
      hit.snapshot.currencyMismatch !== undefined &&
      hit.snapshot.nextEarningsDate !== undefined &&
      hit.snapshot.industry !== undefined &&
      hit.variants !== undefined
    )
      return hit;
  }
  const snapshot = await fetchSnapshot(ticker);
  const calibratedValuation = computeValuation(snapshot, {}, "calibrated");
  const textbookValuation = computeValuation(snapshot, {}, "textbook");
  const calibratedQuality = computeQuality(snapshot, calibratedValuation.composite);
  const textbookQuality = computeQuality(snapshot, textbookValuation.composite);
  const gate = computeGate(snapshot);
  const bundle: StockBundle = {
    snapshot,
    valuation: calibratedValuation,
    quality: calibratedQuality,
    gate,
    variants: {
      calibrated: { valuation: calibratedValuation, quality: calibratedQuality },
      textbook: { valuation: textbookValuation, quality: textbookQuality },
    },
  };
  cacheSet(key, bundle, TTL_24H);
  return bundle;
}
