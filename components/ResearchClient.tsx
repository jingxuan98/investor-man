"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { geminiHeaders } from "@/lib/geminiKeyHeader";

type ReportType = "research" | "model3" | "bear" | "bull" | "risks" | "deepdive";

const REPORTS: { type: ReportType; label: string; desc: string }[] = [
  {
    type: "research",
    label: "Full Research Report",
    desc: "7-section equity research: business model, financials, valuation, catalysts, risks, thesis.",
  },
  {
    type: "model3",
    label: "3-Statement Model",
    desc: "Projected income statement, balance sheet and cash flow with scenarios and FCF sensitivity.",
  },
  {
    type: "bear",
    label: "Bear Case",
    desc: "The most credible, evidence-based downside — where the model breaks and the price target.",
  },
  {
    type: "bull",
    label: "Bull Case",
    desc: "The most credible, evidence-based upside — where the business compounds and the price target.",
  },
  {
    type: "risks",
    label: "Key Risks",
    desc: "Regulatory, concentration, competitive, execution and valuation risks — ranked, with metrics to watch.",
  },
  {
    type: "deepdive",
    label: "Valuation Deep-Dive",
    desc: "Walks our 10 valuation methods, which to trust for this business, and a growth/discount-rate sensitivity table.",
  },
];

export default function ResearchClient({ ticker }: { ticker: string }) {
  const [active, setActive] = useState<ReportType | null>(null);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Monotonic run token: a newer run retires older ones so their appends don't
  // interleave into the current report.
  const runId = useRef(0);

  async function run(type: ReportType, force: boolean) {
    const id = ++runId.current;
    const active = () => runId.current === id;

    setActive(type);
    setText("");
    setError(null);
    setDone(false);
    setStreaming(true);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...geminiHeaders() },
        body: JSON.stringify({ ticker, type, force }),
      });

      // Handle non-200 BEFORE reading the body as a stream: error responses
      // are JSON, not the plain-text report stream.
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
          setError("Something went wrong generating this report. Please try again.");
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
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS.map((r) => (
          <button
            key={r.type}
            onClick={() => run(r.type, false)}
            disabled={streaming}
            className={`rounded-lg border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
              active === r.type
                ? "border-accent bg-accent-tint"
                : "border-line bg-card hover:bg-track"
            }`}
          >
            <div className="font-semibold text-ink">{r.label}</div>
            <div className="mt-1 text-sm text-ink2">{r.desc}</div>
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red bg-red-tint p-4 text-sm text-red">
          {error}
        </div>
      )}

      {active && !error && (
        <div className="card p-6">
          {streaming && text === "" && <p className="text-sm text-ink2">Generating report…</p>}
          <article className="report-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </article>
          {streaming && text !== "" && <p className="mt-4 text-sm text-ink2">Streaming…</p>}
          {done && (
            <button onClick={() => run(active, true)} className="btn btn-outline mt-4">
              Regenerate
            </button>
          )}
        </div>
      )}
    </div>
  );
}
