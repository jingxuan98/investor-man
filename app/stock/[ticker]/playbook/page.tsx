import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import ResearchClient from "@/components/ResearchClient";

export default async function PlaybookPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;
  // Guard the ticker here too (see value/page.tsx): a notFound() from the
  // parent layout does not render this segment's not-found UI on its own.
  let snapshot;
  try {
    ({ snapshot } = await getStockBundle(ticker));
  } catch {
    notFound();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink2">
        The Playbook is a field guide to what happens next: the catalyst calendar, probability-weighted
        scenarios, ranked risks, and what the market currently believes — how the market plays this stock.
      </p>
      {/* Same data/props pattern as the AI Insights (research) page — see
          app/stock/[ticker]/research/page.tsx for why hasServerKey is passed
          through rather than gated here (BYO-key users have no server key). */}
      <ResearchClient
        ticker={snapshot.ticker}
        hasServerKey={Boolean(process.env.GEMINI_API_KEY)}
        types={["playbook"]}
      />
    </div>
  );
}
