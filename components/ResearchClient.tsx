"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { geminiHeaders, GEMINI_KEY_STORAGE_KEY } from "@/lib/geminiKeyHeader";
import { exportReportPdf } from "@/lib/exportPdf";
import { useVariant } from "@/components/VariantProvider";

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

const NO_KEY_HINT =
  "Add your free Gemini API key via the key button in the header to enable reports — aistudio.google.com/apikey.";

export default function ResearchClient({
  ticker,
  hasServerKey,
}: {
  ticker: string;
  hasServerKey: boolean;
}) {
  const [active, setActive] = useState<ReportType | null>(null);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether a browser (BYO) key is present in localStorage. Checked once on
  // mount (client-only — the server has no visibility into localStorage) so
  // we can show a friendly inline hint when NEITHER the server env key nor a
  // browser key is available. The report buttons stay enabled either way —
  // a 503 from the server carries the same hint if the user clicks through.
  const [hasBrowserKey, setHasBrowserKey] = useState(false);
  // Global calibrated/textbook selection — sent with every report request so
  // the prompt's data block/methods table embed the SAME variant driving the
  // rest of the site (task brief: "AI insight prompts"). The research route
  // keys its cache on {ticker, type, variant}, so switching variants doesn't
  // serve a stale report computed under the other one.
  const { variant } = useVariant();
  const reportRef = useRef<HTMLElement>(null);
  const [pdfNote, setPdfNote] = useState<string | null>(null);
  // Monotonic run token: a newer run retires older ones so their appends don't
  // interleave into the current report.
  const runId = useRef(0);

  useEffect(() => {
    setHasBrowserKey(!!window.localStorage.getItem(GEMINI_KEY_STORAGE_KEY));
  }, []);

  function handleExportPdf() {
    setPdfNote(null);
    if (!reportRef.current) return;
    const label = REPORTS.find((r) => r.type === active)?.label ?? "AI Research Report";
    const ok = exportReportPdf(`${ticker} — ${label}`, reportRef.current.innerHTML);
    if (!ok) setPdfNote("Your browser blocked the popup — allow popups for this site to export.");
  }

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
        body: JSON.stringify({ ticker, type, force, variant }),
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
        } else if (code === "model_unavailable") {
          // Reason: a hard, non-retryable failure straight from the Gemini
          // API call (all models in the chain rejected it) — distinct from
          // our own pipeline breaking, so tell the user it's the model, not
          // a bug, and that retrying shortly is the right move.
          setError("The AI model is rate-limited or temporarily unavailable — please try again shortly.");
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
      {!hasServerKey && !hasBrowserKey && (
        <div className="rounded-lg border border-amber bg-amber-tint p-4 text-sm text-amber">
          {NO_KEY_HINT}
        </div>
      )}

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
          {done && (
            <div className="mb-3 flex justify-end">
              <button onClick={handleExportPdf} className="btn btn-outline !py-1 text-xs">
                Export PDF
              </button>
            </div>
          )}
          {pdfNote && <p className="mb-3 text-xs text-ink2">{pdfNote}</p>}
          <article ref={reportRef} className="report-md">
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
