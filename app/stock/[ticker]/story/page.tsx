import { notFound } from "next/navigation";
import { getStockBundle, bundleForVariant, StockBundle } from "@/lib/data/getStockData";
import { reverseDcf } from "@/lib/finance/insights";
import { buildStory } from "@/lib/finance/story";
import StoryClient, { StoryVariantData } from "@/components/StoryClient";

// Hard ceiling on this segment's data phase. Every upstream fetch below
// getStockBundle already carries its own ~5s AbortSignal.timeout (Yahoo via
// lib/data/yahoo.ts's timedFetch, SEC EDGAR in lib/data/edgar.ts), so this
// race is a belt-and-braces guarantee: even if some future code path awaits
// an un-timed promise, the segment renders the friendly fallback below
// instead of hanging at the loading skeleton forever (the prod failure mode
// this fixes). 15s comfortably covers a full cold-cache assembly (~6s
// measured locally in prod mode).
const STORY_TIMEOUT_MS = 15_000;

// Friendly degraded state — the bundle is a 24h-cached derivation, so a
// refresh once the upstream recovers (or lands on a warm-cache instance) is
// the correct retry path.
function StoryUnavailable() {
  return (
    <section className="card p-6">
      <p className="font-medium text-ink">The Story is temporarily unavailable.</p>
      <p className="mt-1 text-sm text-ink2">
        An upstream data source is responding slowly. Refresh the page to retry.
      </p>
    </section>
  );
}

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
  // Reason: the timer must be cleared on EVERY exit (resolve, timeout return,
  // notFound throw) so a settled render never leaves a dangling timeout
  // keeping a serverless instance's event loop busy.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // getStockBundle is the only awaited step in this segment — everything
    // after it (reverseDcf, buildStory) is pure synchronous math — so racing
    // it bounds the whole story assembly.
    const raced = await Promise.race([
      getStockBundle(ticker),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), STORY_TIMEOUT_MS);
      }),
    ]);
    if (raced === "timeout") return <StoryUnavailable />;
    bundle = raced;
  } catch {
    notFound();
  } finally {
    clearTimeout(timer);
  }
  const { snapshot: s } = bundle;
  // reverseDcf isn't part of either variant's valuation pair (it's a
  // separate solve off autoWacc/threeStagePv, shared by both — see
  // lib/finance/story.ts), so it's computed once and passed to both
  // buildStory() calls below, same as the pre-variant-toggle behavior.
  const reverse = reverseDcf(s);

  // Degrades gracefully: a null/missing nextEarningsDate (e.g. Yahoo's
  // calendarEvents timed out or returned an odd shape) simply omits the
  // "NEXT CATALYST" line in StoryClient's header strip.
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
