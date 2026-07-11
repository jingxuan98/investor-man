import { cacheGet, cacheSet } from "@/lib/db";
import { fetchSnapshot } from "./yahoo";
import { computeValuation } from "@/lib/finance/valuation";
import { computeQuality } from "@/lib/finance/grading";
import { computeGate } from "@/lib/finance/gate";
import { FinancialSnapshot, ValuationOutput, QualityOutput } from "@/lib/finance/types";
import { GateOutput } from "@/lib/finance/gate";

export interface StockBundle {
  snapshot: FinancialSnapshot;
  valuation: ValuationOutput;
  quality: QualityOutput;
  gate: GateOutput;
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
    if (
      hit &&
      hit.gate &&
      hit.snapshot.currencyMismatch !== undefined &&
      hit.snapshot.nextEarningsDate !== undefined &&
      hit.snapshot.industry !== undefined
    )
      return hit;
  }
  const snapshot = await fetchSnapshot(ticker);
  const valuation = computeValuation(snapshot);
  const quality = computeQuality(snapshot, valuation.composite);
  const gate = computeGate(snapshot);
  const bundle = { snapshot, valuation, quality, gate };
  cacheSet(key, bundle, TTL_24H);
  return bundle;
}
