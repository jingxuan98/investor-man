"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { geminiHeaders } from "@/lib/geminiKeyHeader";

// The Story tab's "Draft with AI" enrichment — a single-button variant of
// ResearchClient's fetch/stream pattern, fixed to the "story" report type.
// POSTs /api/research { ticker, type: "story" }, which rewrites our
// machine-drafted blocks 1-3 (see lib/finance/story.ts + lib/ai/prompts.ts's
// storyPrompt) as an editorial pass. Cached server-side under research:{T}:story.
export default function StoryDraft({ ticker }: { ticker: string }) {
  const [started, setStarted] = useState(false);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic run token: a newer run retires older ones so their appends don't
  // interleave into the current draft.
  const runId = useRef(0);

  async function run(force: boolean) {
    const id = ++runId.current;
    const active = () => runId.current === id;

    setStarted(true);
    setText("");
    setError(null);
    setDone(false);
    setStreaming(true);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...geminiHeaders() },
        body: JSON.stringify({ ticker, type: "story", force }),
      });

      // Handle non-200 BEFORE reading the body as a stream: error responses
      // are JSON, not the plain-text draft stream.
      if (!res.ok) {
        let code = "";
        try {
          code = (await res.json())?.error ?? "";
        } catch {
          /* non-JSON error body */
        }
        if (!active()) return;
        if (res.status === 429) {
          setError("Rate limited — try again in a minute.");
        } else if (res.status === 503 || code === "no_api_key") {
          setError(
            "No AI key available — click the key icon in the header to add your free Gemini API key (aistudio.google.com/apikey)."
          );
        } else {
          setError("Something went wrong drafting this note. Please try again.");
        }
        setStreaming(false);
        return;
      }

      if (!res.body) {
        if (active()) {
          setError("No response body received.");
          setStreaming(false);
        }
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done: rdDone, value } = await reader.read();
        if (rdDone) break;
        if (!active()) {
          reader.cancel();
          return;
        }
        if (value) {
          const chunk = dec.decode(value, { stream: true });
          setText((prev) => prev + chunk);
        }
      }
      if (!active()) return;
      setStreaming(false);
      setDone(true);
    } catch {
      if (!active()) return;
      setError("Connection interrupted while streaming. Please try again.");
      setStreaming(false);
    }
  }

  return (
    <div>
      {!started && (
        <button type="button" onClick={() => run(false)} className="btn btn-outline">
          ✦ Draft with AI
        </button>
      )}

      {error && (
        <div className="rounded-lg border border-red bg-red-tint p-4 text-sm text-red">{error}</div>
      )}

      {started && !error && (
        <div className="rounded-lg border border-line bg-page p-6">
          {streaming && text === "" && (
            <p className="text-sm text-ink2">Drafting editorial pass…</p>
          )}
          <article className="report-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </article>
          {streaming && text !== "" && <p className="mt-4 text-sm text-ink2">Streaming…</p>}
          {done && (
            <button onClick={() => run(true)} className="btn btn-outline mt-4">
              Regenerate
            </button>
          )}
        </div>
      )}
    </div>
  );
}
