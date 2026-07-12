// Server-only Gemini REST client. Never import from client components:
// it reads GEMINI_API_KEY from the environment and embeds it in request URLs.
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Ordered model chain: the primary model (GEMINI_MODEL) followed by the
// comma-separated GEMINI_FALLBACK_MODELS. Exported so the parse/order logic can
// be unit-tested without a network or an API key.
export function modelChain(): string[] {
  const primary = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
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

// --- Patient retry/backoff for Gemini's free-tier rate limits --------------
// Free-tier RPM caps (5-15 depending on model) make 429s routine, not
// exceptional. The user has explicitly accepted longer loading in exchange
// for fewer hard failures, so instead of burning through the whole model
// chain the instant a 429/500/503 shows up, we wait out a short, bounded
// delay and retry the SAME model once before falling back — a much higher
// success rate for a modest latency cost. Shared by geminiJSON and
// geminiStream so both get identical pacing.
const DEFAULT_429_WAIT_MS = 5_000; // used when Google gives no retry hint at all
const MAX_429_WAIT_MS = 20_000;
const RETRY_500_WAIT_MS = 4_000;
const MODEL_GAP_MS = 2_000; // pacing gap between falling back to the next model
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

type Attempt =
  | { kind: "ok"; res: Response }
  // Retryable status on both this attempt and its same-model retry (or the
  // retry was skipped because the budget ran out) — caller falls back to the
  // next model.
  | { kind: "give-up"; status: number }
  | { kind: "network-error" };

// Runs one model's fetch. On a retryable status (429/500/503), waits a
// patient, bounded delay and retries the SAME model exactly once before
// giving up on it. Every wait is clamped to whatever's left of `deadline` —
// once the overall request budget is spent, the retry is skipped entirely
// (no further sleeping) and this model is given up on immediately, letting
// the caller move on to the next model (or fail) without adding more delay.
async function fetchWithPatientRetry(
  doFetch: () => Promise<Response>,
  deadline: number
): Promise<Attempt> {
  let res: Response;
  try {
    res = await doFetch();
  } catch {
    return { kind: "network-error" };
  }
  if (!isRetryableStatus(res.status)) return { kind: "ok", res };

  const remaining = deadline - Date.now();
  if (remaining <= 0) return { kind: "give-up", status: res.status };

  let waitMs: number;
  if (res.status === 429) {
    const bodyText = await res.text().catch(() => "");
    waitMs = Math.min(parseRetryDelayMs(res, bodyText) ?? DEFAULT_429_WAIT_MS, MAX_429_WAIT_MS);
  } else {
    waitMs = RETRY_500_WAIT_MS;
  }
  waitMs = Math.min(waitMs, remaining);
  await sleep(waitMs);

  let retryRes: Response;
  try {
    retryRes = await doFetch();
  } catch {
    return { kind: "network-error" };
  }
  if (!isRetryableStatus(retryRes.status)) return { kind: "ok", res: retryRes };
  return { kind: "give-up", status: retryRes.status };
}

// Pacing gap before trying the next model in the chain, so a burst of
// fallback attempts doesn't hammer the next model in the same instant. A
// no-op once the overall budget is spent — the next model is still worth
// trying immediately, just without adding more artificial delay.
async function gapBeforeNextModel(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await sleep(Math.min(MODEL_GAP_MS, remaining));
}

// The final, chain-exhausted error. Once the patience budget has actually
// run out, surface this as a distinct code (mapped by callers to the
// friendly "model_unavailable" response) rather than the ordinary
// RATE_LIMITED path (mapped to a curt "try again in a minute") — the caller
// already waited patiently, so "try again shortly" is the honest message.
function chainExhaustedError(deadline: number): Error {
  return Date.now() >= deadline
    ? new Error("GEMINI_BUDGET_EXCEEDED")
    : new Error("RATE_LIMITED");
}

export async function geminiJSON<T>(prompt: string, apiKey?: string): Promise<T> {
  const { key, models } = cfg(apiKey);
  const deadline = Date.now() + GEMINI_REQUEST_BUDGET_MS;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const last = i === models.length - 1;
    if (i > 0) await gapBeforeNextModel(deadline);

    const attempt = await fetchWithPatientRetry(
      () =>
        fetch(`${BASE}/${model}:generateContent?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        }),
      deadline
    );

    if (attempt.kind === "network-error") {
      if (last) throw chainExhaustedError(deadline);
      console.warn("[gemini] network error on", model, "→ falling back to", models[i + 1]);
      continue;
    }
    if (attempt.kind === "give-up") {
      if (last) throw chainExhaustedError(deadline);
      console.warn(
        "[gemini]",
        attempt.status,
        "on",
        model,
        "(after patient retry) → falling back to",
        models[i + 1]
      );
      continue;
    }
    const res = attempt.res;
    if (!res.ok) throw new Error(`GEMINI_ERROR_${res.status}`);
    const data = await res.json();
    const text =
      data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    try {
      return JSON.parse(text) as T;
    } catch {
      // Reason: a model (esp. a weaker fallback like gemma) occasionally
      // returns truncated/malformed JSON despite responseMimeType being set
      // — this used to throw uncaught straight out of the function, skipping
      // every remaining fallback model entirely. Treat it the same as a
      // transient status: try the next model in the chain before giving up.
      if (last) throw new Error("GEMINI_PARSE_ERROR");
      console.warn("[gemini] malformed JSON from", model, "→ falling back to", models[i + 1]);
      continue;
    }
  }
  // Unreachable: an empty chain is impossible (modelChain always includes the
  // primary). Present so every path returns/throws for TypeScript.
  throw chainExhaustedError(deadline);
}

// Returns a plain-text chunk stream (just the text deltas) extracted from
// Gemini's SSE response — NOT SSE format. Iterates the model chain on transient
// failures (429/503/network) the same way geminiJSON does, using the same
// shared patient-retry/pacing helpers.
export async function geminiStream(
  prompt: string,
  opts: { grounding?: boolean; apiKey?: string } = {}
): Promise<ReadableStream<Uint8Array>> {
  const { key, models } = cfg(opts.apiKey);
  const deadline = Date.now() + GEMINI_REQUEST_BUDGET_MS;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const last = i === models.length - 1;
    if (i > 0) await gapBeforeNextModel(deadline);

    const body: any = { contents: [{ parts: [{ text: prompt }] }] };
    // Grounding guard: the google_search tool is only supported by gemini-*
    // models. Non-gemini models (e.g. gemma-*) reject tool declarations, so omit
    // tools entirely for those attempts.
    if (opts.grounding && model.startsWith("gemini")) {
      body.tools = [{ google_search: {} }];
    }

    const attempt = await fetchWithPatientRetry(
      () =>
        fetch(`${BASE}/${model}:streamGenerateContent?alt=sse&key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      deadline
    );

    if (attempt.kind === "network-error") {
      if (last) throw chainExhaustedError(deadline);
      console.warn("[gemini] network error on", model, "→ falling back to", models[i + 1]);
      continue;
    }
    if (attempt.kind === "give-up") {
      if (last) throw chainExhaustedError(deadline);
      console.warn(
        "[gemini]",
        attempt.status,
        "on",
        model,
        "(after patient retry) → falling back to",
        models[i + 1]
      );
      continue;
    }
    const res = attempt.res;
    if (!res.ok || !res.body) throw new Error(`GEMINI_ERROR_${res.status}`);
    return sseTextStream(res.body);
  }
  // Unreachable (see geminiJSON).
  throw chainExhaustedError(deadline);
}

// Wraps Gemini's raw SSE byte stream into a plain-text delta stream.
function sseTextStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const t =
            j.candidates?.[0]?.content?.parts
              ?.map((p: any) => p.text ?? "")
              .join("") ?? "";
          if (t) controller.enqueue(enc.encode(t));
        } catch {
          /* partial line, ignore */
        }
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
