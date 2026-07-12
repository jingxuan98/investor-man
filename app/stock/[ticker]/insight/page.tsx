import { notFound } from "next/navigation";
import { getStockBundle, bundleForVariant, variantPair, StockBundle } from "@/lib/data/getStockData";
import { GateOutput } from "@/lib/finance/gate";
import { DimensionScore } from "@/lib/finance/types";
import { buildAnalystNote } from "@/lib/finance/insightNote";
import { pegRatio, trailingPE } from "@/lib/finance/valuation";
import InsightClient, { InsightVariantData } from "@/components/InsightClient";

// Reference-site dimension ordering: Predictability, Profitability, Growth,
// Economic moat, Financial strength, Valuation.
const DIM_ORDER = ["predictability", "profitability", "growth", "moat", "finStrength", "valuation"];

function orderDims(dims: DimensionScore[]): DimensionScore[] {
  return [...dims].sort((a, b) => DIM_ORDER.indexOf(a.key) - DIM_ORDER.indexOf(b.key));
}

// Pull an already-computed reading string out of the Quality Gate's factors
// (bundle.gate.factors[].readings) instead of recomputing ROIC / buyback
// yield from scratch — the numbers must match the Metrics/Gate views exactly.
function gateReading(gate: GateOutput, factorKey: string, label: string): string | null {
  const f = gate.factors.find((x) => x.key === factorKey);
  const r = f?.readings.find((x) => x.label === label);
  return r ? r.value : null;
}

export default async function InsightPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  // Guard again here (not just in the layout): notFound() thrown from a
  // parent layout does not trigger a not-found.tsx in that same segment
  // (Next.js caveat), so the page itself must also validate the ticker for
  // our custom not-found UI to render instead of the framework default.
  let bundle: StockBundle;
  try {
    bundle = await getStockBundle(ticker);
  } catch {
    notFound();
  }
  const { snapshot: s, gate } = bundle;

  const roicReading = gateReading(gate, "roicVsWacc", "ROIC") ?? "n/a";
  const buybackReading = gateReading(gate, "capitalAllocation", "Buyback yield") ?? "n/a";

  // Debt/Equity isn't exposed as a gate reading (only ROIC and buyback yield
  // are), so it's read directly off the latest statement year here — same
  // one-line formula already used inline in Metrics and Grading, not a new
  // scoring computation. Variant-independent (raw balance-sheet ratio).
  const y0 = s.years[0];
  const dte = y0 && y0.equity && y0.equity > 0 && y0.totalDebt !== null ? y0.totalDebt / y0.equity : null;
  const dteReading = dte === null ? "n/a" : `${dte.toFixed(2)}×`;

  const fetchedDate = new Date(s.fetchedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  // The global variant toggle grades this whole tab off the selected
  // variant's composite — compute BOTH variants' worth of display data
  // server-side (cheap, pure) and let the client leaf pick, no refetch.
  const pair = variantPair(bundle);
  function dataFor(variant: "calibrated" | "textbook"): InsightVariantData {
    const { valuation: v, quality: q } = pair[variant];
    const upside = v.composite !== null ? v.composite / s.price - 1 : null;
    const vb = bundleForVariant(bundle, variant);
    return {
      orderedDims: orderDims(q.dimensions),
      overallScore: q.overallScore,
      overallGrade: q.overallGrade,
      fairValue: v.composite,
      upside,
      noteParagraphs: buildAnalystNote(vb),
    };
  }

  return (
    <InsightClient
      ticker={s.ticker}
      name={s.name}
      sector={s.sector}
      currency={s.currency}
      roicReading={roicReading}
      dteReading={dteReading}
      buybackReading={buybackReading}
      ownPE={trailingPE(s)}
      ownPEG={pegRatio(s)}
      fetchedDate={fetchedDate}
      variants={{ calibrated: dataFor("calibrated"), textbook: dataFor("textbook") }}
    />
  );
}
