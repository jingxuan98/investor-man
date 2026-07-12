import { notFound } from "next/navigation";
import { getStockBundle, bundleForVariant, StockBundle } from "@/lib/data/getStockData";
import { reverseDcf } from "@/lib/finance/insights";
import { buildStory } from "@/lib/finance/story";
import StoryClient, { StoryVariantData } from "@/components/StoryClient";

export default async function StoryPage({
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
  const { snapshot: s } = bundle;
  // reverseDcf isn't part of either variant's valuation pair (it's a
  // separate solve off autoWacc/threeStagePv, shared by both — see
  // lib/finance/story.ts), so it's computed once and passed to both
  // buildStory() calls below, same as the pre-variant-toggle behavior.
  const reverse = reverseDcf(s);

  const catalystDate = s.nextEarningsDate
    ? new Date(s.nextEarningsDate)
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toUpperCase()
    : null;

  // The global variant toggle grades the whole tab off the selected
  // variant's valuation pair — compute BOTH variants' stories server-side
  // (buildStory is pure/cheap) and let the client leaf pick, no refetch.
  function dataFor(variant: "calibrated" | "textbook"): StoryVariantData {
    const vb = bundleForVariant(bundle, variant);
    const story = buildStory(vb, reverse);
    const upside = vb.valuation.composite !== null ? vb.valuation.composite / s.price - 1 : null;
    return { story, upside };
  }

  return (
    <StoryClient
      ticker={s.ticker}
      price={s.price}
      currency={s.currency}
      catalystDate={catalystDate}
      variants={{ calibrated: dataFor("calibrated"), textbook: dataFor("textbook") }}
    />
  );
}
