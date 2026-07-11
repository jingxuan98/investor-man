import { NextResponse } from "next/server";
import { cacheGet, cacheSet } from "@/lib/db";
import { geminiJSON, parseCompetitors } from "@/lib/ai/gemini";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const T = ticker.toUpperCase();
  const key = `competitors:${T}`;
  const hit = cacheGet<{ ticker: string; name: string }[]>(key);
  if (hit) return NextResponse.json({ competitors: hit });
  // BYO key: see app/api/research/route.ts for the header contract.
  const apiKey = req.headers.get("x-gemini-key")?.trim() || undefined;
  try {
    const raw = await geminiJSON<unknown>(
      `List the 5 closest publicly listed competitors of the US-listed stock ${T}. ` +
        `US-listed tickers only. Respond ONLY with a JSON array: ` +
        `[{"ticker": "XXX", "name": "Company Name"}]. Do not include ${T} itself.`,
      apiKey
    );
    const comps = parseCompetitors(raw);
    // Only cache non-empty lists so a transient bad LLM response is retried.
    if (comps.length) cacheSet(key, comps, 7 * 24 * 3600);
    return NextResponse.json({ competitors: comps });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "RATE_LIMITED") {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    if (msg === "GEMINI_KEY_MISSING") {
      return NextResponse.json({ error: "no_api_key" }, { status: 503 });
    }
    console.error("[competitors] geminiJSON failed:", e);
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
