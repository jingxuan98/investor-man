import { NextResponse } from "next/server";
import { getStockBundle, bundleForVariant } from "@/lib/data/getStockData";
import { geminiStream } from "@/lib/ai/gemini";
import { buildPrompt, isReportType } from "@/lib/ai/prompts";
import { cacheGet, cacheSet } from "@/lib/db";
import { ValuationVariant } from "@/lib/finance/types";

const TTL_24H = 24 * 3600;

// Headroom for the patient Gemini retry/backoff in lib/ai/gemini.ts (up to a
// ~75s internal budget in the worst case — every model rate-limited). This
// route streams, so the client starts seeing output as soon as any model
// call succeeds; the extra ceiling only matters for the pathological
// all-models-busy case.
export const maxDuration = 90;

// POST { ticker, type, force?, variant? } → streamed plain-text markdown of
// the report. Cache key research:{TICKER}:{type}:{variant} — MUST include
// variant, since the data block/methods table embed the selected variant's
// composite/models (see bundleForVariant below); serving a cached calibrated
// report for a textbook request (or vice versa) would silently show the
// wrong numbers. On a miss the Gemini stream is piped through a
// TransformStream that accumulates the text INSIDE the response lifecycle
// and writes the cache in flush() — which only runs when the stream
// completes cleanly. This keeps accumulation attached to the response (a
// detached background loop gets killed when the response finishes in Next.js
// dev, which silently dropped the cache write), so a partial or aborted stream
// never reaches flush() and never poisons the cache.
export async function POST(req: Request) {
  let body: { ticker?: unknown; type?: unknown; force?: unknown; variant?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ticker =
    typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
  const type = body.type;
  const force = body.force === true;
  const variant: ValuationVariant = body.variant === "textbook" ? "textbook" : "calibrated";
  // BYO key: the browser stores its own Gemini key in localStorage and sends
  // it per-request via this header when no server-side env key is set (prod).
  const apiKey = req.headers.get("x-gemini-key")?.trim() || undefined;

  if (!ticker) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isReportType(type)) {
    return NextResponse.json({ error: "bad_type" }, { status: 400 });
  }

  const cacheKey = `research:${ticker}:${type}:${variant}`;

  // Cached hit → return the whole body at once.
  if (!force) {
    const cached = cacheGet<string>(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Cache": "hit" },
      });
    }
  }

  let bundle;
  try {
    bundle = await getStockBundle(ticker);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    if (msg === "TICKER_NOT_FOUND") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // Don't leak raw upstream error text to the client; log server-side instead.
    console.error("[research] getStockBundle failed:", e);
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }

  const { prompt, grounding } = buildPrompt(type, bundleForVariant(bundle, variant));

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await geminiStream(prompt, { grounding, apiKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GEMINI_ERROR";
    if (msg === "RATE_LIMITED") {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    if (msg === "GEMINI_KEY_MISSING") {
      return NextResponse.json({ error: "no_api_key" }, { status: 503 });
    }
    // Reason: distinct from the getStockBundle catch above's "upstream_error"
    // (our own data-fetch pipeline) — this is a hard, non-retryable failure
    // straight from the Gemini API call itself (e.g. a one-off 400/403/404 on
    // every model in the chain). The client shows a model-specific message
    // instead of the generic one, since telling the user to just "try again"
    // is accurate here — it's the model, not our code, that failed.
    console.error("[research] geminiStream failed:", e);
    return NextResponse.json({ error: "model_unavailable" }, { status: 502 });
  }

  // Accumulate the full text as chunks pass through to the client. flush() runs
  // only when the source stream closes cleanly (not on abort/error), so the
  // cache write happens inside the response lifecycle and never persists a
  // partial body.
  let full = "";
  const dec = new TextDecoder();
  const cachingStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      full += dec.decode(chunk, { stream: true });
      controller.enqueue(chunk);
    },
    flush() {
      full += dec.decode();
      // Reason: never cache an empty result (e.g. grounding produced no text).
      if (full.trim()) cacheSet(cacheKey, full, TTL_24H);
    },
  });

  return new Response(stream.pipeThrough(cachingStream), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Cache": "miss" },
  });
}
