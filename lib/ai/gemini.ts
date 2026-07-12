// Server-only Gemini REST client. Never import from client components:
// it reads GEMINI_API_KEY from the environment and embeds it in request URLs.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Ordered model chain: the primary model (GEMINI_MODEL) followed by the
// comma-separated GEMINI_FALLBACK_MODELS. Exported so the parse/order logic can
// be unit-tested without a network or an API key.
export function modelChain(): string[] {
  // Default primary must match .env.local's GEMINI_MODEL — prod (Vercel) sets
  // no env vars and runs on this default; it briefly shipped as 2.5-flash and
  // silently served an older model than intended (caught via the model badge).
  const primary = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
  const fallbacks = (
    process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.1-flash-lite,gemma-4-31b-it"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...fallbacks];
}

// Key resolution: an explicit caller-supplied key (from the request's
// x-gemini-key header, e.g. a user's BYO key in production) wins; otherwise
// fall back to the server's own GEMINI_API_KEY (local dev / self-hosted).
// Never log the resolved key.
function cfg(apiKey?: string) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_KEY_MISSING");
  return { key, models: modelChain() };
}

// 429 (rate limited), 503 (model overloaded/unavailable), and 500 (Gemini's
// own transient internal error — seen in practice under load) are the
// statuses worth retrying against the next model in the chain. Every other
// non-OK status is a hard error (bad request, auth, etc.) and fails immediately.
function isRetryableStatus(s: number): boolean {
  return s === 429 || s === 503 || s === 500;
}

// --- Two-pass (sprint → patient) fallback for free-tier rate limits --------
// Free-tier RPM/daily caps (5-15 RPM) make 429s routine — and in practice it
// is USUALLY the primary model whose daily quota is exhausted, so patiently
// retrying the same model first would add dead time to almost every request.
// Strategy instead:
//   PASS 1 (sprint): one attempt per model, in chain order. On a retryable
//     failure (429/500/503/network) move straight to the next model — only a
//     1s courtesy gap so the next model isn't hammered in the same instant.
//     A model that a very recent request saw a 429 on is skipped outright
//     via the module-level cooldown map below.
//   PASS 2 (patient, only if pass 1 fully failed with ≥1 transient failure):
//     re-walk the chain, this time honoring Google's suggested retry delay
//     per model (min(delay, 20s); 5s default when no hint was given), or 4s
//     after a 500/503 — all within the remaining wall-clock budget.
// Shared by geminiJSON and geminiStream so both get identical pacing.
const SPRINT_GAP_MS = 1_000;
const DEFAULT_429_WAIT_MS = 5_000; // used when Google gives no retry hint at all
const MAX_429_WAIT_MS = 20_000;
const RETRY_5XX_WAIT_MS = 4_000;
const OTHER_RETRY_WAIT_MS = 1_000; // pass-2 pacing after network/parse failures
// Overall wall-clock budget per request across every model/attempt/wait,
// keeping a request comfortably inside typical serverless duration limits
// (see the `maxDuration` route exports) even in the worst case where every
// model in the chain is rate-limited.
export const GEMINI_REQUEST_BUDGET_MS = 75_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Extracts Google's own suggested retry delay from a 429 response: the
// Retry-After header, or the RetryInfo detail embedded in the JSON error body
// (`{"error":{"details":[{"@type":".../RetryInfo","retryDelay":"20s"}]}}`).
// Returns milliseconds, or null if neither is present (caller falls back to
// a fixed default). Never throws — a malformed/absent body just yields null.
function parseRetryDelayMs(res: Response, bodyText: string): number | null {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  }
  try {
    const details = JSON.parse(bodyText)?.error?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const raw = typeof d?.retryDelay === "string" ? d.retryDelay.trim() : null;
        const m = raw ? /^([\d.]+)s$/.exec(raw) : null;
        if (m) return parseFloat(m[1]) * 1000;
      }
    }
  } catch {
    /* body wasn't JSON, or had no RetryInfo detail — fall through to null */
  }
  return null;
}

// Module-level cooldown map: model → earliest-retry timestamp learned from
// that model's last 429 (Google's suggested retryDelay, capped). Lets pass 1
// of a NEW request skip a model that a request seconds ago learned is
// exhausted — warm serverless instances benefit; cold starts just see an
// empty map. Plain in-memory Map, no persistence, by design.
const modelCooldownUntil = new Map<string, number>();

// Test hook: the cooldown map is module-level state and would otherwise leak
// learned 429 cooldowns between unit tests.
export function clearGeminiModelCooldowns(): void {
  modelCooldownUntil.clear();
}

// Per-request record of a model's most recent failure, so pass 2 knows how
// long each model asked us to wait. kind "transient" covers 429/500/503 and
// network errors (status undefined); "parse" is an OK response whose output
// the consumer couldn't use (malformed JSON).
interface Failure {
  kind: "transient" | "parse";
  status?: number;
  retryAfterMs?: number | null; // Google's suggested delay — 429 only
}

// What `consume` (the per-caller response handler) reports back to the chain
// runner: a usable value, or "unusable output — try the next model".
type ConsumeResult<T> = { ok: true; value: T } | { ok: false };

// Result of a successful chain run: the value plus which model in the chain
// actually produced it — callers surface this for model-attribution (the
// "which model served this" badge shown on every AI output surface).
export interface ChainResult<T> {
  value: T;
  model: string;
}

// The shared two-pass chain runner (see the strategy comment above). Hard
// errors — non-retryable non-OK statuses like 400/403, or anything `consume`
// throws — abort the whole chain immediately: no other model can fix those.
async function runModelChain<T>(
  models: string[],
  doFetch: (model: string) => Promise<Response>,
  consume: (res: Response, model: string) => Promise<ConsumeResult<T>>
): Promise<ChainResult<T>> {
  const deadline = Date.now() + GEMINI_REQUEST_BUDGET_MS;
  const failures = new Map<string, Failure>();
  // Reason: an append-only log (rather than a `let lastFailure` mutated from
  // the closure below) — TypeScript's flow analysis can't see closure
  // assignments, so a plain variable would stay narrowed to null.
  const failureLog: Failure[] = [];
  let budgetExceeded = false;

  const recordFailure = (model: string, f: Failure) => {
    failures.set(model, f);
    failureLog.push(f);
  };

  // One request against one model; classifies the outcome without waiting.
  const attempt = async (model: string): Promise<ConsumeResult<T>> => {
    let res: Response;
    try {
      res = await doFetch(model);
    } catch {
      console.warn("[gemini] network error on", model);
      recordFailure(model, { kind: "transient" });
      return { ok: false };
    }
    if (isRetryableStatus(res.status)) {
      let retryAfterMs: number | null = null;
      if (res.status === 429) {
        const bodyText = await res.text().catch(() => "");
        retryAfterMs = parseRetryDelayMs(res, bodyText);
        // Remember when this model is worth trying again, so other requests
        // on this (warm) instance can skip it during their sprint pass.
        modelCooldownUntil.set(
          model,
          Date.now() + Math.min(retryAfterMs ?? DEFAULT_429_WAIT_MS, MAX_429_WAIT_MS)
        );
      }
      console.warn("[gemini]", res.status, "on", model);
      recordFailure(model, { kind: "transient", status: res.status, retryAfterMs });
      return { ok: false };
    }
    if (!res.ok) throw new Error(`GEMINI_ERROR_${res.status}`);
    const out = await consume(res, model);
    if (!out.ok) recordFailure(model, { kind: "parse" });
    return out;
  };

  // PASS 1 — sprint through the chain, one attempt per model, never waiting
  // on a rate limit: the primary model's quota is usually the exhausted one,
  // so the fastest route to output is the next model, not a same-model retry.
  let gapNeeded = false;
  for (const model of models) {
    const coolUntil = modelCooldownUntil.get(model) ?? 0;
    if (coolUntil > Date.now()) {
      // A request moments ago learned this model is rate-limited — record it
      // as a 429 (with the remaining cooldown as its suggested delay) without
      // spending a real request on it.
      console.warn("[gemini] skipping", model, "— cooling down after a recent 429");
      recordFailure(model, {
        kind: "transient",
        status: 429,
        retryAfterMs: coolUntil - Date.now(),
      });
      continue;
    }
    if (gapNeeded) {
      await sleep(Math.min(SPRINT_GAP_MS, Math.max(deadline - Date.now(), 0)));
    }
    const out = await attempt(model);
    if (out.ok) return { value: out.value, model };
    // Courtesy gap only after an actual transient failure — a parse failure
    // didn't rate-limit anything, so the next model needs no pacing.
    gapNeeded = failures.get(model)?.kind === "transient";
  }

  // PASS 2 — patient re-walk, only when something transient failed in pass 1.
  // (An all-parse-failures pass 1 means the models are responding fine but
  // emitting unusable output — waiting won't change that, so fail now.)
  if (failureLog.some((f) => f.kind === "transient")) {
    for (const model of models) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Budget spent — fail fast to the friendly model_unavailable error
        // rather than risk blowing past the route's maxDuration.
        budgetExceeded = true;
        break;
      }
      const f = failures.get(model);
      const wait =
        f?.status === 429
          ? Math.min(f.retryAfterMs ?? DEFAULT_429_WAIT_MS, MAX_429_WAIT_MS)
          : f?.status === 500 || f?.status === 503
            ? RETRY_5XX_WAIT_MS
            : OTHER_RETRY_WAIT_MS;
      await sleep(Math.min(wait, remaining));
      const out = await attempt(model);
      if (out.ok) return { value: out.value, model };
    }
  }

  // Chain exhausted. GEMINI_BUDGET_EXCEEDED intentionally does NOT match the
  // routes' RATE_LIMITED branch (curt "try again in a minute") — it falls to
  // their default model_unavailable response ("temporarily unavailable — try
  // again shortly"), the honest message after we already waited patiently.
  if (budgetExceeded) throw new Error("GEMINI_BUDGET_EXCEEDED");
  if (failureLog[failureLog.length - 1]?.kind === "parse") {
    throw new Error("GEMINI_PARSE_ERROR");
  }
  throw new Error("RATE_LIMITED");
}

export async function geminiJSON<T>(
  prompt: string,
  apiKey?: string,
  // Optional chain override — e.g. the competitors fallback runs gemma-only
  // to keep the scarce gemini-flash daily quota for reports/story drafts.
  modelsOverride?: string[]
): Promise<ChainResult<T>> {
  const { key, models: defaultModels } = cfg(apiKey);
  const models = modelsOverride?.length ? modelsOverride : defaultModels;
  return runModelChain<T>(
    models,
    (model) =>
      fetch(`${BASE}/${model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }),
    async (res, model) => {
      const data = await res.json();
      const text =
        data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
      try {
        return { ok: true, value: JSON.parse(text) as T };
      } catch {
        // Reason: a model (esp. a weaker fallback like gemma) occasionally
        // returns truncated/malformed JSON despite responseMimeType being
        // set — report it as unusable so the chain tries the next model;
        // GEMINI_PARSE_ERROR only surfaces if no model ever parses.
        console.warn("[gemini] malformed JSON from", model);
        return { ok: false };
      }
    }
  );
}

// Returns a plain-text chunk stream (just the text deltas) extracted from
// Gemini's SSE response — NOT SSE format. Same two-pass chain runner (and
// therefore identical pacing) as geminiJSON.
export async function geminiStream(
  prompt: string,
  opts: { grounding?: boolean; apiKey?: string } = {}
): Promise<ChainResult<ReadableStream<Uint8Array>>> {
  const { key, models } = cfg(opts.apiKey);
  return runModelChain<ReadableStream<Uint8Array>>(
    models,
    (model) => {
      const body: any = { contents: [{ parts: [{ text: prompt }] }] };
      // Grounding guard: the google_search tool is only supported by gemini-*
      // models. Non-gemini models (e.g. gemma-*) reject tool declarations, so
      // omit tools entirely for those attempts.
      if (opts.grounding && model.startsWith("gemini")) {
        body.tools = [{ google_search: {} }];
      }
      return fetch(`${BASE}/${model}:streamGenerateContent?alt=sse&key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async (res) => {
      // OK status but no body — a hard error, not something another model's
      // retry fixes (matches the previous behavior).
      if (!res.body) throw new Error(`GEMINI_ERROR_${res.status}`);
      return { ok: true, value: scrubReasoningLeak(sseTextStream(res.body)) };
    }
  );
}

// Wraps Gemini's raw SSE byte stream into a plain-text delta stream.
//
// Reason: thinking-capable models (and occasionally weaker fallbacks like
// gemma) mark their internal planning/reasoning parts with `thought: true`
// on candidates[].content.parts. Those parts are never meant to be shown to
// the user — concatenating every part indiscriminately (the old behavior)
// leaked that reasoning into the visible report. Filtering them here is the
// API-level fix; models that leak reasoning as plain untagged text (gemma has
// no thought flag) still need the plain-text scrubber below.
export function sseTextStream(
  source: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Reason: a ReadableStream's pull() is only re-invoked by the stream
      // machinery in response to a NEW external trigger (a consumer read(),
      // or an enqueue happening concurrently) — not simply because a prior
      // pull() call returned without enqueueing anything. If a single read()
      // off the source yields only a partial line, or a message consisting
      // entirely of a thought-flagged part (now filtered to empty text), a
      // one-shot pull() that returns empty-handed would silently stall the
      // stream forever. Loop internally until this call has enqueued
      // something or the source has ended.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let emitted = false;
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const t =
              j.candidates?.[0]?.content?.parts
                ?.filter((p: any) => p?.thought !== true)
                ?.map((p: any) => p.text ?? "")
                .join("") ?? "";
            if (t) {
              controller.enqueue(enc.encode(t));
              emitted = true;
            }
          } catch {
            /* partial line, ignore */
          }
        }
        if (emitted) return;
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// --- Plain-text reasoning-leak scrubber -------------------------------------
// Some fallback models (notably gemma, which has no `thought` flag at all)
// emit their planning/preamble as ordinary visible text ahead of the actual
// report — e.g. "Okay, the user wants a deep-dive on..." or a <thinking>
// block, before the real `# `/`## ` markdown content begins. This is purely
// cosmetic (the report itself is fine) but looks broken mid-stream and ends
// up baked into the cache.
//
// Strategy: buffer only the first ~DECISION_WINDOW_CHARS of the stream (never
// the whole response) looking for the first markdown heading line. Once a
// heading is found — or the window is exhausted, or the stream ends first —
// decide once:
//   - a leading <thinking>...</thinking> block is always stripped once its
//     closing tag is seen;
//   - otherwise, if there's a heading and the text before it look like a
//     model thinking out loud (matches REASONING_START_RE) and starts within
//     the window, strip everything before the heading;
//   - otherwise pass the buffered text through unchanged — a legitimate
//     report opening with a normal paragraph must never be eaten.
// After the decision, every subsequent chunk is passed straight through with
// zero buffering — this never holds up the rest of the stream.
const DECISION_WINDOW_CHARS = 800;
const HEADING_RE = /^#{1,2}[ \t]+\S/m;
const THINKING_BLOCK_RE = /^\s*<thinking>[\s\S]*?<\/thinking>\s*/i;
const LEADING_THINKING_TAG_RE = /^\s*<thinking>/i;
const REASONING_START_RE =
  /^\s*(okay|ok|alright|sure|got it|hmm|let me|let's|let us|i need to|i'll|i will|i should|i must|the user wants|the user is asking|the user has asked|first,? let me|first,? i)\b/i;

// Looks at everything buffered so far and either returns a final decision
// (the text to emit, scrubbed or not) or `null` when more data is needed
// before a decision can be made.
function decideScrub(buf: string): string | null {
  const thinkingBlock = THINKING_BLOCK_RE.exec(buf);
  if (thinkingBlock) return buf.slice(thinkingBlock[0].length);
  // A <thinking> tag has opened but its closing tag hasn't arrived yet —
  // keep buffering (bounded by the window check below) rather than
  // prematurely deciding this isn't a thinking block.
  if (LEADING_THINKING_TAG_RE.test(buf) && buf.length < DECISION_WINDOW_CHARS) {
    return null;
  }

  const heading = HEADING_RE.exec(buf);
  if (heading) {
    const idx = heading.index;
    const preamble = buf.slice(0, idx);
    if (idx > 0 && idx <= DECISION_WINDOW_CHARS && REASONING_START_RE.test(preamble.trim())) {
      return buf.slice(idx);
    }
    return buf; // no preamble, or preamble doesn't look like reasoning — pass through
  }

  if (buf.length >= DECISION_WINDOW_CHARS) return buf; // no heading in the window — pass through
  return null; // keep buffering
}

export function scrubReasoningLeak(
  source: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let decided = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (decided) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        return;
      }
      // Reason: same pull()-must-not-return-empty-handed constraint as
      // sseTextStream above — loop internally until a decision is reached
      // (something enqueued) or the source ends.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          // Stream ended before a decision point was reached (short
          // response, no heading) — flush whatever's buffered exactly as
          // received.
          if (buf) controller.enqueue(enc.encode(buf));
          controller.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        const result = decideScrub(buf);
        if (result !== null) {
          decided = true;
          if (result) controller.enqueue(enc.encode(result));
          return;
        }
        // else: not enough data yet to decide — keep reading.
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

export function parseCompetitors(raw: unknown): { ticker: string; name: string }[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: { ticker: string; name: string }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = String((item as any).ticker ?? "")
      .trim()
      .toUpperCase();
    const n = String((item as any).name ?? t);
    if (!t || !/^[A-Z.\-]{1,10}$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push({ ticker: t, name: n });
    if (out.length === 5) break;
  }
  return out;
}
