import { NextResponse } from "next/server";
import { getStockBundle } from "@/lib/data/getStockData";

export async function GET(
  _: Request,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  try {
    const { snapshot: s, valuation: v, quality: q } = await getStockBundle(ticker);
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
