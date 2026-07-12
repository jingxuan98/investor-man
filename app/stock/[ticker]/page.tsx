import { notFound } from "next/navigation";
import { getStockBundle, variantPair } from "@/lib/data/getStockData";
import CompetitorsPanel from "@/components/CompetitorsPanel";
import GateCard from "@/components/GateCard";
import OverviewStats from "@/components/OverviewStats";

export default async function StockOverviewPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  // Guard again here (not just in the layout): notFound() thrown from a
  // parent layout does not trigger a not-found.tsx in that same segment
  // (Next.js caveat), so the page itself must also validate the ticker for
  // our custom not-found UI to render instead of the framework default.
  let bundle;
  try {
    bundle = await getStockBundle(ticker);
  } catch {
    notFound();
  }
  const { snapshot: s, gate } = bundle;
  const pair = variantPair(bundle);

  // Quality word for the verdict now comes from the Quality Gate grade:
  // A/B → High-quality, C → Decent, D/F → Low-quality. The Gate is
  // variant-independent (never reads the composite), so this label is
  // computed once and shared by both variants in OverviewStats.
  const qualityLabel =
    gate.grade === "A" || gate.grade === "B"
      ? "High-quality"
      : gate.grade === "C"
        ? "Decent"
        : "Low-quality";

  return (
    <div className="space-y-10">
      <section>
        <OverviewStats
          price={s.price}
          currency={s.currency}
          qualityLabel={qualityLabel}
          stats={{
            calibrated: {
              composite: pair.calibrated.valuation.composite,
              range: pair.calibrated.valuation.range,
            },
            textbook: {
              composite: pair.textbook.valuation.composite,
              range: pair.textbook.valuation.range,
            },
          }}
        />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-ink">Quality</h2>
        <GateCard gate={gate} />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-ink">Competitors</h2>
        <CompetitorsPanel ticker={s.ticker} sector={s.sector} />
      </section>
    </div>
  );
}
