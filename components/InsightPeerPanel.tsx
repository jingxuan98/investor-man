"use client";

import { useEffect, useRef, useState } from "react";
import { geminiHeaders } from "@/lib/geminiKeyHeader";

interface Competitor {
  ticker: string;
  name: string;
}

interface Summary {
  ticker: string;
  name: string;
  price: number | null;
  fairValue: number | null;
  upside: number | null;
  qualityScore: number | null;
}

// A row is either still loading its summary (undefined), failed (null), or resolved.
type RowState = Summary | null | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BarRow {
  ticker: string;
  name: string;
  isSelf: boolean;
  loading: boolean;
  failed: boolean;
  quality: number | null;
  upside: number | null; // decimal, e.g. 0.186
}

export default function InsightPeerPanel({
  ticker,
  name,
  ownQualityScore,
  ownUpside,
}: {
  ticker: string;
  name: string;
  ownQualityScore: number | null;
  ownUpside: number | null;
}) {
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [noApiKey, setNoApiKey] = useState(false);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [view, setView] = useState<"quality" | "valuation">("quality");
  // Monotonic token: see CompetitorsPanel for the rationale (StrictMode remount safety).
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    const active = () => runId.current === id;
    setListState("loading");
    setNoApiKey(false);
    setCompetitors([]);
    setRows({});

    (async () => {
      let list: Competitor[];
      try {
        const res = await fetch(`/api/competitors/${ticker}`, { headers: geminiHeaders() });
        if (!res.ok) {
          if (res.status === 503) {
            const data = await res.json().catch(() => null);
            if (data?.error === "no_api_key" && active()) setNoApiKey(true);
          }
          throw new Error("list_failed");
        }
        const data = await res.json();
        list = Array.isArray(data.competitors) ? data.competitors : [];
      } catch {
        if (active()) setListState("error");
        return;
      }
      if (!active()) return;
      setCompetitors(list);
      setListState("ready");
      setRows(Object.fromEntries(list.map((c) => [c.ticker, undefined])));

      // Sequential with a small gap so rows stream in one at a time (same
      // pattern as CompetitorsPanel) rather than firing 5 requests at once.
      for (const c of list) {
        if (!active()) return;
        let summary: RowState = null;
        try {
          const res = await fetch(`/api/summary/${c.ticker}`);
          if (res.ok) summary = (await res.json()) as Summary;
        } catch {
          summary = null;
        }
        if (!active()) return;
        setRows((prev) => ({ ...prev, [c.ticker]: summary }));
        await sleep(300);
      }
    })();
  }, [ticker]);

  if (listState === "error") {
    return (
      <p className="text-sm text-ink2">
        Peer comparison unavailable
        {noApiKey &&
          " — click the key icon in the header to add your free Gemini API key (aistudio.google.com/apikey)."}
      </p>
    );
  }

  if (listState === "loading") {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg border border-line bg-track" />
        ))}
      </div>
    );
  }

  if (competitors.length === 0) {
    return <p className="text-sm text-ink2">No competitors found</p>;
  }

  const barRows: BarRow[] = [
    {
      ticker,
      name,
      isSelf: true,
      loading: false,
      failed: false,
      quality: ownQualityScore,
      upside: ownUpside,
    },
    ...competitors.map((c) => {
      const row = rows[c.ticker];
      return {
        ticker: c.ticker,
        name: c.name,
        isSelf: false,
        loading: row === undefined,
        failed: row === null,
        quality: row ? row.qualityScore : null,
        upside: row ? row.upside : null,
      };
    }),
  ];

  const metricOf = (r: BarRow): number | null => {
    if (view === "quality") return r.quality;
    return r.upside !== null ? r.upside * 100 : null;
  };
  const maxAbs = Math.max(...barRows.map((r) => Math.abs(metricOf(r) ?? 0)), 1e-9);

  return (
    <div>
      <div className="mb-4 flex gap-2">
        {(["quality", "valuation"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              view === v
                ? "border border-accent bg-accent-tint text-accent"
                : "border border-line bg-card text-ink3 hover:bg-track"
            }`}
          >
            {v === "quality" ? "Quality" : "Valuation"}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {barRows.map((r) => {
          const m = metricOf(r);
          const widthPct = m === null ? 0 : (Math.abs(m) / maxAbs) * 100;
          const barColor =
            view === "quality"
              ? r.isSelf
                ? "bg-accent"
                : "bg-track"
              : m !== null && m < 0
              ? "bg-red"
              : "bg-green";
          return (
            <div key={r.ticker}>
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className={r.isSelf ? "font-semibold text-ink" : "text-ink3"}>
                  {r.ticker} <span className="text-ink2">{r.name}</span>
                  {r.isSelf && <span className="ml-2 text-xs text-ink2">· this stock</span>}
                </span>
                <span className={`num ${r.isSelf ? "font-semibold text-ink" : "text-ink2"}`}>
                  {r.loading
                    ? "…"
                    : r.failed || m === null
                    ? "n/a"
                    : view === "quality"
                    ? m.toFixed(1)
                    : `${m >= 0 ? "+" : ""}${m.toFixed(1)}%`}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-track">
                {!r.loading && !r.failed && m !== null && (
                  <div className={`h-2 rounded-full ${barColor}`} style={{ width: `${widthPct}%` }} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
