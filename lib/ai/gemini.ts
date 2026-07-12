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

export async function geminiJSON<T>(prompt: string, apiKey?: string): Promise<T> {
  const { key, models } = cfg(apiKey);
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const last = i === models.length - 1;
    let res: Response;
    try {
      res = await fetch(`${BASE}/${model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });
    } catch {
      // Network/transport failure → retry against the next model.
      if (last) throw new Error("RATE_LIMITED");
      console.warn("[gemini] network error on", model, "→ falling back to", models[i + 1]);
      continue;
    }
    if (isRetryableStatus(res.status)) {
      if (last) throw new Error("RATE_LIMITED");
      console.warn("[gemini]", res.status, "on", model, "→ falling back to", models[i + 1]);
      continue;
    }
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
  throw new Error("RATE_LIMITED");
}

// Returns a plain-text chunk stream (just the text deltas) extracted from
// Gemini's SSE response — NOT SSE format. Iterates the model chain on transient
// failures (429/503/network) the same way geminiJSON does.
export async function geminiStream(
  prompt: string,
  opts: { grounding?: boolean; apiKey?: string } = {}
): Promise<ReadableStream<Uint8Array>> {
  const { key, models } = cfg(opts.apiKey);
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const last = i === models.length - 1;
    const body: any = { contents: [{ parts: [{ text: prompt }] }] };
    // Grounding guard: the google_search tool is only supported by gemini-*
    // models. Non-gemini models (e.g. gemma-*) reject tool declarations, so omit
    // tools entirely for those attempts.
    if (opts.grounding && model.startsWith("gemini")) {
      body.tools = [{ google_search: {} }];
    }
    let res: Response;
    try {
      res = await fetch(
        `${BASE}/${model}:streamGenerateContent?alt=sse&key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
    } catch {
      if (last) throw new Error("RATE_LIMITED");
      console.warn("[gemini] network error on", model, "→ falling back to", models[i + 1]);
      continue;
    }
    if (isRetryableStatus(res.status)) {
      if (last) throw new Error("RATE_LIMITED");
      console.warn("[gemini]", res.status, "on", model, "→ falling back to", models[i + 1]);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`GEMINI_ERROR_${res.status}`);
    return sseTextStream(res.body);
  }
  // Unreachable (see geminiJSON).
  throw new Error("RATE_LIMITED");
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
