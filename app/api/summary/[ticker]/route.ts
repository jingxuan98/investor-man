import { NextResponse } from "next/server";
import { getStockBundle, variantPair } from "@/lib/data/getStockData";
import { ValuationVariant } from "@/lib/finance/types";

// CompetitorsPanel / InsightPeerPanel send the viewer's globally-selected
// variant (?variant=calibrated|textbook) so a peer's fair value/upside/
// quality score reflects the SAME calibrated-vs-textbook choice as the
// subject stock's own tabs — otherwise flipping the header toggle would
// change the subject's numbers but leave every peer row on calibrated.
function parseVariant(v: string | null): ValuationVariant {
  return v === "textbook" ? "textbook" : "calibrated";
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const variant = parseVariant(new URL(req.url).searchParams.get("variant"));
  try {
    const bundle = await getStockBundle(ticker);
    const s = bundle.snapshot;
    const { valuation: v, quality: q } = variantPair(bundle)[variant];
    const fairValue = v.composite;
    const upside = fairValue !== null ? fairValue / s.price - 1 : null;
    return NextResponse.json({
      ticker: s.ticker,
      name: s.name,
      price: s.price,
      fairValue,
      upside,
      // Additive field for the peer-comparison chart; existing
      // consumers (CompetitorsPanel) ignore unknown JSON fields.
      qualityScore: q.overallScore,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "TICKER_NOT_FOUND") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    console.error("[summary] getStockBundle failed:", e);
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
