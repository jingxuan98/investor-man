import { notFound } from "next/navigation";
import { getStockBundle } from "@/lib/data/getStockData";
import ResearchClient from "@/components/ResearchClient";

export default async function ResearchPage({
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

  // No API key configured → explain instead of erroring. The key is read
  // server-side only and never shipped to the client.
  if (!process.env.GEMINI_API_KEY) {
    return (
      <div className="card p-6">
        <h2 className="mb-2 text-lg font-semibold text-ink">AI research is disabled</h2>
        <p className="text-sm text-ink3">
          Add <code className="rounded bg-track px-1 py-0.5">GEMINI_API_KEY</code> to{" "}
          <code className="rounded bg-track px-1 py-0.5">.env.local</code> to enable AI research
          reports.
        </p>
      </div>
    );
  }

  return <ResearchClient ticker={snapshot.ticker} />;
}
