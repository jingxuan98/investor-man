import Link from "next/link";
import { notFound } from "next/navigation";
import { getStockBundle, variantPair } from "@/lib/data/getStockData";
import { classifyStock, revenueCagr5y } from "@/lib/finance/assumptions";
import StockTabs from "@/components/StockTabs";
import SearchBar from "@/components/SearchBar";
import GeminiKeyButton from "@/components/GeminiKeyButton";
import Logo from "@/components/Logo";
import { VariantProvider } from "@/components/VariantProvider";
import VariantToggle from "@/components/VariantToggle";
import HeaderPriceLine from "@/components/HeaderPriceLine";

const STYLE_BADGE: Record<"growth" | "balanced" | "mature", { label: string; className: string }> = {
  growth: { label: "Growth stock", className: "style-badge-growth" },
  balanced: { label: "Balanced", className: "style-badge-balanced" },
  mature: { label: "Mature", className: "style-badge-mature" },
};

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
  const { snapshot: s } = bundle;
  const pair = variantPair(bundle);
  const composites = {
    calibrated: pair.calibrated.valuation.composite,
    textbook: pair.textbook.valuation.composite,
  };
  // Investor-style badge — server-side, pure/null-safe: classifyStock always
  // resolves (defaults to "mature" absent history), but we only show the
  // badge when we have a live CAGR number to put in the tooltip.
  const cagr = revenueCagr5y(s);
  const stockClass = cagr === null ? null : classifyStock(s);
  const tabs = [
    ["Overview", `/stock/${s.ticker}`],
    ["Intrinsic Value", `/stock/${s.ticker}/value`],
    ["Metrics", `/stock/${s.ticker}/metrics`],
    ["SuperInvestor", `/stock/${s.ticker}/insight`],
    ["The Story", `/stock/${s.ticker}/story`],
    ["AI Insights", `/stock/${s.ticker}/research`],
    ["AI Playbook", `/stock/${s.ticker}/playbook`],
  ] as const;
  return (
    <VariantProvider>
      <div className="mx-auto min-w-0 w-full max-w-5xl bg-page p-6">
        <Link href="/" className="mb-3 inline-flex w-fit">
          <Logo size={24} />
        </Link>
        <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-ink">
              <span className="min-w-0 break-words">
                {s.name} <span className="text-ink2">({s.ticker})</span>
              </span>
              {s.sector && <span className="badge-outline">{s.sector}</span>}
              {stockClass && (
                <span
                  className={`style-badge ${STYLE_BADGE[stockClass].className}`}
                  title={`Auto-detected from 5Y revenue CAGR of ${(cagr! * 100).toFixed(0)}%`}
                >
                  {STYLE_BADGE[stockClass].label}
                </span>
              )}
            </h1>
            <HeaderPriceLine price={s.price} currency={s.currency} composites={composites} />
            {/* Global calibrated/textbook selection — every tab's grading/advice
                (Overview signal, competitor/sector comparisons, The Story, the
                Intrinsic Value table, AI Insight prompts) reads this SAME state
                via useVariant(), persisted to localStorage. */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink2">Valuation basis:</span>
              <VariantToggle />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SearchBar className="w-56" />
            <GeminiKeyButton />
            <StockTabs tabs={tabs} />
          </div>
        </header>
        {children}
      </div>
    </VariantProvider>
  );
}
