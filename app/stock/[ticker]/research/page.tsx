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

  // The server key is only one possible source of a Gemini key — in
  // production (Vercel) there is no GEMINI_API_KEY env var by design, and
  // the user supplies their own key from the browser instead (see
  // GeminiKeyButton + lib/geminiKeyHeader.ts, sent as x-gemini-key per
  // request). So ResearchClient must always render and stay interactive;
  // it's the one that knows (from localStorage, client-side) whether a
  // browser key is present, and shows its own inline hint banner when
  // neither source has a key.
  return (
    <ResearchClient ticker={snapshot.ticker} hasServerKey={Boolean(process.env.GEMINI_API_KEY)} />
  );
}
