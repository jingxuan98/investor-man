import { NextResponse } from "next/server";
import { cacheGet, cacheSet } from "@/lib/db";
import { geminiJSON, parseCompetitors } from "@/lib/ai/gemini";

// Headroom for the patient Gemini retry/backoff in lib/ai/gemini.ts (up to a
// ~75s internal budget in the worst case — every model rate-limited). Unlike
// /api/research this route is non-streaming JSON — the client waits the
// FULL duration before seeing anything — so this ceiling must comfortably
// exceed that 75s budget or the platform could kill the function first.
export const maxDuration = 90;

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
    // Reason: same distinction as app/api/research/route.ts — a hard,
    // non-retryable failure from the Gemini call itself, not our own pipeline.
    console.error("[competitors] geminiJSON failed:", e);
    return NextResponse.json({ error: "model_unavailable" }, { status: 502 });
  }
}
